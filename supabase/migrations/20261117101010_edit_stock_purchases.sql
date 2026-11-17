begin;

alter table squishy_shop.purchases add column revision integer not null default 0;
create index on squishy_shop.order_lines (lot_id);
alter table squishy_shop.stock drop constraint stock_kind_check;
alter table squishy_shop.stock add constraint stock_kind_check
  check (kind in ('purchase','sale','cancelled','returned','adjustment'));

create function public.shop_stock_write(p_actor integer, p_action text, p_data jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  item_id integer := (p_data->>'id')::integer;
  day date := (p_data->>'date')::date;
  change_date date := (now() at time zone 'Europe/Istanbul')::date;
  purchase_name text := p_data->>'name';
  purchase_total integer := (p_data->>'total')::integer;
  purchase_row squishy_shop.purchases%rowtype;
  product_row squishy_shop.products%rowtype;
  lot squishy_shop.lots%rowtype;
  line jsonb;
  lot_id_to_edit integer;
  new_quantity integer;
  new_cost integer;
  used_quantity integer;
  quantity_change integer;
begin
  if p_action is distinct from 'purchase-edit' then
    raise exception using errcode='P0001', message='Geçersiz stok işlemi.', detail='400';
  end if;
  if not exists (select 1 from squishy_shop.members where id=p_actor) then
    raise exception using errcode='P0001', message='Kullanıcı bulunamadı.', detail='404';
  end if;
  if purchase_total is null or purchase_total < 1 or purchase_total is distinct from (
    select sum((value->>'quantity')::bigint * (value->>'unitCost')::integer)
    from jsonb_array_elements(p_data->'lines')
  ) then
    raise exception using errcode='P0001', message='Ürün maliyetleri alım toplamıyla eşleşmeli.', detail='400';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_data->'lines') where value->>'lotId' is not null
    group by (value->>'lotId')::integer having count(*)>1
  ) then
    raise exception using errcode='P0001', message='Her alım satırını bir kez gönderin.', detail='400';
  end if;

  select * into purchase_row from squishy_shop.purchases where id=item_id for update;
  if not found then
    raise exception using errcode='P0001', message='Stok alımı bulunamadı.', detail='404';
  end if;
  if purchase_row.revision is distinct from (p_data->>'revision')::integer then
    raise exception using errcode='P0001', message='Bu stok alımı değişti. Düzenlemeyi kapatıp güncel kaydı açın.', detail='409';
  end if;

  -- Use the same product locks and lock order as sales, returns and new purchases.
  perform p.id from squishy_shop.products p where p.id in (
    select l.product_id from squishy_shop.lots l where l.purchase_id=item_id
    union
    select (value->>'productId')::integer from jsonb_array_elements(p_data->'lines')
  ) order by p.id for update;

  for lot in
    select l.* from squishy_shop.lots l where l.purchase_id=item_id and not exists (
      select 1 from jsonb_array_elements(p_data->'lines') where (value->>'lotId')::integer=l.id
    )
  loop
    if exists (select 1 from squishy_shop.order_lines where lot_id=lot.id) then
      raise exception using errcode='P0001', message=format('%s satış geçmişi olduğu için alımdan çıkarılamaz.',lot.product_name), detail='409';
    end if;
    delete from squishy_shop.lots where id=lot.id;
    insert into squishy_shop.stock (product_id,product_name,date,kind,quantity,unit_cost,actor_id,reference)
    values (lot.product_id,lot.product_name,change_date,'adjustment',-lot.remaining,lot.unit_cost,p_actor,purchase_name);
  end loop;

  for line in select value from jsonb_array_elements(p_data->'lines')
  loop
    lot_id_to_edit := (line->>'lotId')::integer;
    new_quantity := (line->>'quantity')::integer;
    new_cost := (line->>'unitCost')::integer;
    select * into product_row from squishy_shop.products where id=(line->>'productId')::integer;
    if not found then
      raise exception using errcode='P0001', message='Ürün bulunamadı.', detail='404';
    end if;

    if lot_id_to_edit is null then
      insert into squishy_shop.lots (purchase_id,product_id,product_name,quantity,remaining,unit_cost)
      values (item_id,product_row.id,product_row.name,new_quantity,new_quantity,new_cost);
      quantity_change := new_quantity;
    else
      select * into lot from squishy_shop.lots where id=lot_id_to_edit and purchase_id=item_id;
      if not found then
        raise exception using errcode='P0001', message='Bu alıma ait ürün satırı bulunamadı.', detail='404';
      end if;
      used_quantity := lot.quantity-lot.remaining;
      if new_quantity < used_quantity then
        raise exception using errcode='P0001', message=format('%s için adet satışlarda kullanılan %s adedin altına inemez.',lot.product_name,used_quantity), detail='409';
      end if;
      if (new_cost<>lot.unit_cost or product_row.id<>lot.product_id)
        and exists (select 1 from squishy_shop.order_lines where lot_id=lot.id) then
        raise exception using errcode='P0001', message=format('%s için ürün ve maliyet satış geçmişi nedeniyle sabit.',lot.product_name), detail='409';
      end if;
      if product_row.id<>lot.product_id then
        insert into squishy_shop.stock (product_id,product_name,date,kind,quantity,unit_cost,actor_id,reference)
        values (lot.product_id,lot.product_name,change_date,'adjustment',-lot.remaining,lot.unit_cost,p_actor,purchase_name);
        quantity_change := new_quantity;
      else
        quantity_change := new_quantity-lot.quantity;
      end if;
      update squishy_shop.lots
      set product_id=product_row.id,product_name=case when product_row.id=lot.product_id then lot.product_name else product_row.name end,
          quantity=new_quantity,remaining=new_quantity-used_quantity,unit_cost=new_cost
      where id=lot.id;
    end if;

    if quantity_change<>0 then
      insert into squishy_shop.stock (product_id,product_name,date,kind,quantity,unit_cost,actor_id,reference)
      values (product_row.id,product_row.name,change_date,'adjustment',quantity_change,new_cost,p_actor,purchase_name);
    end if;
  end loop;

  update squishy_shop.purchases set name=purchase_name,date=day,total=purchase_total,revision=revision+1 where id=item_id;
  update squishy_shop.cash set amount=-purchase_total,description=purchase_name where kind='purchase' and entity_id=item_id;
  insert into squishy_shop.audit (action,entity_id,actor_id,business_date) values (p_action,item_id,p_actor,change_date);
  return jsonb_build_object('ok',true,'id',item_id);
end $$;

revoke all on function public.shop_stock_write(integer,text,jsonb) from public, anon, authenticated;
grant execute on function public.shop_stock_write(integer,text,jsonb) to service_role;

create or replace function public.shop_read(p_action text, p_data jsonb)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  month_start date := date_trunc('month', now() at time zone 'Europe/Istanbul')::date;
  month_end date := (month_start + interval '1 month')::date;
begin
  if p_action='photo' then
    return (select to_jsonb(p.photo) from squishy_shop.products p where p.id=(p_data->>'id')::integer);
  end if;
  if p_action is distinct from 'state' then
    raise exception using errcode='P0001', message='Geçersiz işlem.', detail='400';
  end if;

  return jsonb_build_object(
    'settings', (select jsonb_build_object('defaultPacking',s.default_packing) from squishy_shop.settings s where s.singleton),
    'users', coalesce((
      select jsonb_agg(jsonb_build_object('id',m.id,'username',m.username,'name',m.name) order by m.id)
      from squishy_shop.members m
    ),'[]'::jsonb),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',p.id,'name',p.name,'lowThreshold',p.low_threshold,'firstPartnerShare',p.first_partner_share,
        'listPrice',p.dolap_list_price,'dolapListPrice',p.dolap_list_price,'gardropsListPrice',p.gardrops_list_price,
        'stock',coalesce((select sum(l.remaining) from squishy_shop.lots l where l.product_id=p.id and l.remaining>0),0)
      ) || case when p.photo is null then '{}'::jsonb
        else jsonb_build_object('photo',format('/api/photo?id=%s&v=%s',p.id,p.photo_version)) end
        order by p.id)
      from squishy_shop.products p
    ),'[]'::jsonb),
    'purchases', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',p.id,'name',p.name,'date',p.date,'total',p.total,'actorId',p.actor_id,'revision',p.revision,'paymentDate',c.date,'payerId',c.member_id,
        'lines',coalesce((
          select jsonb_agg(jsonb_build_object(
            'lotId',l.id,'productId',l.product_id,'productName',l.product_name,'quantity',l.quantity,'unitCost',l.unit_cost,
            'usedQuantity',l.quantity-l.remaining,'hasSalesHistory',exists(select 1 from squishy_shop.order_lines ol where ol.lot_id=l.id)
          ) order by l.id)
          from squishy_shop.lots l where l.purchase_id=p.id
        ),'[]'::jsonb)
      ) order by p.date desc,p.id desc)
      from squishy_shop.purchases p left join squishy_shop.cash c on c.kind='purchase' and c.entity_id=p.id
    ),'[]'::jsonb),
    'orders', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',o.id,'platform',o.platform,'reference',o.reference,'date',o.date,'status',o.status,'gross',o.gross,
        'discount',o.discount,'platformFee',o.platform_fee,'shipping',o.shipping,'packing',o.packing,'cost',o.cost,
        'expectedReceipt',coalesce(o.net_after_shipping,o.gross-o.platform_fee),
        'netAfterShipping',o.net_after_shipping,
        'profit',case when o.status in ('cancelled','returned') then 0 else coalesce(o.net_after_shipping,o.gross-o.platform_fee-o.shipping)-o.packing-o.cost end,
        'actorId',o.actor_id,'receiptDate',c.date,'receiptAmount',c.amount,'recipientId',c.member_id,
        'returnSellable',o.return_sellable,
        'returnLines',coalesce((
          select jsonb_agg(jsonb_build_object('productId',r.product_id,'quantity',r.quantity) order by r.product_id)
          from (
            select l.product_id,sum(l.returned_quantity) as quantity
            from squishy_shop.order_lines l where l.order_id=o.id and l.returned_quantity>0
            group by l.product_id
          ) r
        ),'[]'::jsonb),
        'lines',coalesce((
          select jsonb_agg(jsonb_build_object(
            'productId',l.product_id,'productName',l.product_name,'quantity',l.quantity,
            'listPrice',l.list_price,'agreedPrice',l.agreed_price,'unitCost',l.unit_cost,'cost',l.quantity::bigint*l.unit_cost,
            'purchaseId',lot.purchase_id,'firstPartnerShare',l.first_partner_share
          ) order by l.id)
          from squishy_shop.order_lines l join squishy_shop.lots lot on lot.id=l.lot_id where l.order_id=o.id
        ),'[]'::jsonb)
      ) order by o.date desc,o.id desc)
      from squishy_shop.orders o left join squishy_shop.cash c on c.kind='receipt' and c.entity_id=o.id
    ),'[]'::jsonb),
    'expenses', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',e.id,'category',e.category,'amount',e.amount,'date',e.date,'payerId',e.payer_id,'actorId',e.actor_id,'note',e.note,
        'firstPartnerShare',e.first_partner_share
      ) order by e.date desc,e.id desc)
      from squishy_shop.expenses e
    ),'[]'::jsonb),
    'partnerTransfers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',t.id,'senderId',t.sender_id,'recipientId',t.recipient_id,'amount',t.amount,'date',t.date,'note',t.note
      ) order by t.date desc,t.id desc)
      from squishy_shop.partner_transfers t
    ),'[]'::jsonb),
    'stock', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',s.id,'productId',s.product_id,'productName',s.product_name,'date',s.date,'kind',s.kind,
        'quantity',s.quantity,'unitCost',s.unit_cost,'actorId',s.actor_id,'reference',s.reference
      ) order by s.date desc,s.id desc)
      from squishy_shop.stock s
    ),'[]'::jsonb),
    'cash', coalesce((
      select jsonb_agg(jsonb_build_object(
        'kind',c.kind,'id',c.entity_id,'date',c.date,'amount',c.amount,'memberId',c.member_id,'actorId',c.actor_id,'description',c.description
      ) order by c.date desc,c.entity_id desc,c.kind)
      from squishy_shop.cash c
    ),'[]'::jsonb),
    'audit', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',a.id,'action',a.action,'entityId',a.entity_id,'actorId',a.actor_id,'createdAt',a.created_at,
        'businessDate',a.business_date,'status',a.status
      ) order by a.id desc)
      from squishy_shop.audit a
    ),'[]'::jsonb),
    'summary', jsonb_build_object(
      'month',to_char(month_start,'YYYY-MM'),
      'gross',coalesce((
        select sum(gross) from squishy_shop.orders
        where date>=month_start and date<month_end and status in ('pending','packed')
      ),0),
      'profit',coalesce((
        select sum(coalesce(net_after_shipping,gross-platform_fee-shipping)-packing-cost) from squishy_shop.orders
        where date>=month_start and date<month_end and status in ('pending','packed')
      ),0),
      'collected',coalesce((
        select sum(amount) from squishy_shop.cash where date>=month_start and date<month_end and kind='receipt'
      ),0),
      'cashBalance',coalesce((select sum(amount) from squishy_shop.cash),0)
    )
  );
end $$;

notify pgrst, 'reload schema';

commit;

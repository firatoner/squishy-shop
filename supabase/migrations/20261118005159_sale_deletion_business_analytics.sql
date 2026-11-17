begin;

create table squishy_shop.product_history (
  id integer generated always as identity primary key,
  product_id integer not null references squishy_shop.products,
  kind text not null check (kind in ('price','cost')),
  source text not null check (source in ('baseline','recorded')),
  date date not null,
  recorded_at timestamptz not null default now(),
  dolap_price integer,
  gardrops_price integer,
  unit_cost integer,
  quantity integer,
  purchase_id integer references squishy_shop.purchases on delete set null,
  lot_id integer references squishy_shop.lots on delete set null
);
create index on squishy_shop.product_history(product_id,id);
create index on squishy_shop.product_history(lot_id);
alter table squishy_shop.product_history enable row level security;
revoke all on squishy_shop.product_history from public,anon,authenticated;
revoke all on sequence squishy_shop.product_history_id_seq from public,anon,authenticated;
grant select,insert,update on squishy_shop.product_history to service_role;
grant usage on sequence squishy_shop.product_history_id_seq to service_role;

insert into squishy_shop.product_history(product_id,kind,source,date,dolap_price,gardrops_price)
select id,'price','baseline',(now() at time zone 'Europe/Istanbul')::date,dolap_list_price,gardrops_list_price from squishy_shop.products;
insert into squishy_shop.product_history(product_id,kind,source,date,unit_cost,quantity,purchase_id,lot_id)
select l.product_id,'cost','baseline',p.date,l.unit_cost,l.quantity,p.id,l.id
from squishy_shop.lots l join squishy_shop.purchases p on p.id=l.purchase_id;

create function squishy_shop.record_product_history()
returns trigger language plpgsql security invoker set search_path='' as $$
declare
  day date := (now() at time zone 'Europe/Istanbul')::date;
begin
  if tg_table_name='products' then
    if tg_op='UPDATE' then
      if new.dolap_list_price=old.dolap_list_price and new.gardrops_list_price=old.gardrops_list_price then return new; end if;
    end if;
    insert into squishy_shop.product_history(product_id,kind,source,date,dolap_price,gardrops_price)
    values(new.id,'price','recorded',day,new.dolap_list_price,new.gardrops_list_price);
  else
    if tg_op='UPDATE' then
      if new.unit_cost=old.unit_cost and new.product_id=old.product_id then return new; end if;
    else
      select p.date into day from squishy_shop.purchases p where p.id=new.purchase_id;
    end if;
    insert into squishy_shop.product_history(product_id,kind,source,date,unit_cost,quantity,purchase_id,lot_id)
    values(new.product_id,'cost','recorded',day,new.unit_cost,new.quantity,new.purchase_id,new.id);
  end if;
  return new;
end $$;
revoke all on function squishy_shop.record_product_history() from public,anon,authenticated;
grant execute on function squishy_shop.record_product_history() to service_role;
create trigger product_price_history after insert or update on squishy_shop.products for each row execute function squishy_shop.record_product_history();
create trigger lot_cost_history after insert or update on squishy_shop.lots for each row execute function squishy_shop.record_product_history();

create function public.shop_order_delete(p_actor integer,p_action text,p_data jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  item_id integer := (p_data->>'id')::integer;
  day date := (now() at time zone 'Europe/Istanbul')::date;
  sale squishy_shop.orders%rowtype;
  line squishy_shop.order_lines%rowtype;
  used_quantity integer;
  material record;
begin
  if p_action is distinct from 'order-delete' then
    raise exception using errcode='P0001',message='Geçersiz işlem.',detail='400';
  end if;
  if not exists(select 1 from squishy_shop.members where id=p_actor) then
    raise exception using errcode='P0001',message='Kullanıcı bulunamadı.',detail='404';
  end if;
  select * into sale from squishy_shop.orders where id=item_id for update;
  if not found then raise exception using errcode='P0001',message='Satış bulunamadı.',detail='404'; end if;
  if sale.revision is distinct from (p_data->>'revision')::integer then
    raise exception using errcode='P0001',message='Satış değişti. Güncel kaydı açıp yeniden deneyin.',detail='409';
  end if;
  perform p.id from squishy_shop.products p where p.id in(
    select l.product_id from squishy_shop.order_lines l where l.order_id=item_id
  ) order by p.id for update;
  for line in select * from squishy_shop.order_lines where order_id=item_id order by id
  loop
    used_quantity := case sale.status
      when 'cancelled' then 0
      when 'returned' then line.quantity-line.returned_quantity
      else line.quantity end;
    if used_quantity>0 then
      update squishy_shop.lots l set remaining=l.remaining+used_quantity where l.id=line.lot_id;
      insert into squishy_shop.stock(product_id,product_name,date,kind,quantity,unit_cost,actor_id,reference)
      values(line.product_id,line.product_name,day,'adjustment',used_quantity,line.unit_cost,p_actor,'Silinen satış #'||item_id);
    end if;
  end loop;
  perform m.id from squishy_shop.packaging_materials m where m.id in(
    select material_id from squishy_shop.packaging_movements where order_id=item_id
  ) order by m.id for update;
  for material in
    select material_id,-sum(quantity)::integer as quantity
    from squishy_shop.packaging_movements where order_id=item_id group by material_id
  loop
    if material.quantity<>0 then
      update squishy_shop.packaging_materials m set quantity=m.quantity+material.quantity where m.id=material.material_id;
      insert into squishy_shop.packaging_movements(material_id,date,quantity,note,actor_id)
      values(material.material_id,day,material.quantity,'Silinen satış #'||item_id,p_actor);
    end if;
  end loop;
  update squishy_shop.packaging_movements set order_id=null,note=note||' (silinen satış #'||item_id||')' where order_id=item_id;
  delete from squishy_shop.cash where kind='receipt' and entity_id=item_id;
  delete from squishy_shop.order_lines where order_id=item_id;
  delete from squishy_shop.orders where id=item_id;
  insert into squishy_shop.audit(action,entity_id,actor_id,business_date,status) values(p_action,item_id,p_actor,day,sale.status);
  return jsonb_build_object('ok',true,'id',item_id);
end $$;
revoke all on function public.shop_order_delete(integer,text,jsonb) from public,anon,authenticated;
grant execute on function public.shop_order_delete(integer,text,jsonb) to service_role;

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
        'id',p.id,'name',p.name,'date',p.date,'total',p.total,'actorId',p.actor_id,'revision',p.revision,'paymentDate',c.date,'payerId',case when (select count(*) from squishy_shop.purchase_payment_shares s where s.purchase_id=p.id and s.amount>0)=1
          then (select s.member_id from squishy_shop.purchase_payment_shares s where s.purchase_id=p.id and s.amount>0 limit 1) end,
        'payments',coalesce((select jsonb_agg(jsonb_build_object('payerId',s.member_id,'amount',s.amount,'date',c.date) order by s.member_id)
          from squishy_shop.purchase_payment_shares s where s.purchase_id=p.id and s.amount>0),'[]'::jsonb),
        'lines',coalesce((
          select jsonb_agg(jsonb_build_object(
            'lotId',l.id,'firstPartnerShare',l.first_partner_share,'productId',l.product_id,'productName',l.product_name,'quantity',l.quantity,'unitCost',l.unit_cost,
            'usedQuantity',l.quantity-l.remaining,'hasSalesHistory',(exists(select 1 from squishy_shop.order_lines ol where ol.lot_id=l.id) or exists(select 1 from squishy_shop.stock_loss_lines sl where sl.lot_id=l.id))
          ) order by l.id)
          from squishy_shop.lots l where l.purchase_id=p.id
        ),'[]'::jsonb)
      ) order by p.date desc,p.id desc)
      from squishy_shop.purchases p left join squishy_shop.cash c on c.kind='purchase' and c.entity_id=p.id
    ),'[]'::jsonb),
    'orders', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',o.id,'revision',o.revision,'platform',o.platform,'reference',o.reference,'date',o.date,'status',o.status,'gross',o.gross,
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
            'purchaseId',lot.purchase_id,'lotId',lot.id,'firstPartnerShare',l.first_partner_share
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
    'productHistory',coalesce((
      select jsonb_agg(jsonb_build_object('id',h.id,'productId',h.product_id,'kind',h.kind,'source',h.source,'date',h.date,
        'recordedAt',h.recorded_at,'dolapPrice',h.dolap_price,'gardropsPrice',h.gardrops_price,'unitCost',h.unit_cost,
        'quantity',h.quantity,'purchaseId',h.purchase_id) order by h.id desc) from squishy_shop.product_history h
    ),'[]'::jsonb),
    'stockLosses',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',x.id,'productId',x.product_id,'productName',x.product_name,'quantity',x.quantity,'date',x.date,'reason',x.reason,'note',x.note,
        'lines',(select jsonb_agg(jsonb_build_object('purchaseId',l.purchase_id,'quantity',s.quantity,'unitCost',s.unit_cost,
          'firstPartnerShare',s.first_partner_share) order by s.id)
          from squishy_shop.stock_loss_lines s join squishy_shop.lots l on l.id=s.lot_id where s.loss_id=x.id)
      ) order by x.date desc,x.id desc) from squishy_shop.stock_losses x
    ),'[]'::jsonb),
    'packagingMaterials',coalesce((
      select jsonb_agg(jsonb_build_object('id',m.id,'name',m.name,'quantity',m.quantity,'lowThreshold',m.low_threshold,'perOrder',m.per_order,'revision',m.revision) order by m.id)
      from squishy_shop.packaging_materials m
    ),'[]'::jsonb),
    'packagingMovements',coalesce((
      select jsonb_agg(jsonb_build_object('id',m.id,'materialId',m.material_id,'date',m.date,'quantity',m.quantity,'orderId',m.order_id,'note',m.note) order by m.date desc,m.id desc)
      from squishy_shop.packaging_movements m
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
      from (
        select c.* from squishy_shop.cash c where c.kind<>'purchase'
        union all
        select c.kind,c.entity_id,c.date,-s.amount,s.member_id,c.actor_id,c.description
        from squishy_shop.cash c join squishy_shop.purchase_payment_shares s on s.purchase_id=c.entity_id
        where c.kind='purchase' and s.amount>0
      ) c
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
      ),0)-coalesce((select sum(l.quantity::bigint*l.unit_cost) from squishy_shop.stock_loss_lines l join squishy_shop.stock_losses x on x.id=l.loss_id where x.date>=month_start and x.date<month_end),0),
      'collected',coalesce((
        select sum(amount) from squishy_shop.cash where date>=month_start and date<month_end and kind='receipt'
      ),0),
      'cashBalance',coalesce((select sum(amount) from squishy_shop.cash),0)
    )
  );
end $$;

notify pgrst, 'reload schema';

commit;

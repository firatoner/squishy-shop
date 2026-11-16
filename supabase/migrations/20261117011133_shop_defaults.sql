begin;

create table squishy_shop.settings (
  singleton boolean primary key default true check (singleton),
  default_packing integer not null check (default_packing between 0 and 100000000)
);
insert into squishy_shop.settings (default_packing) values (1000);

alter table squishy_shop.settings enable row level security;
revoke all on squishy_shop.settings from public, anon, authenticated;
grant select, update on squishy_shop.settings to service_role;

create function public.shop_settings_write(p_actor integer, p_action text, p_data jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  packing_amount integer := (p_data->>'defaultPacking')::integer;
begin
  if p_action is distinct from 'settings' or packing_amount is null or packing_amount not between 0 and 100000000 then
    raise exception using errcode='P0001', message='Geçerli bir paketleme tutarı girin.', detail='400';
  end if;
  if not exists (select 1 from squishy_shop.members where id=p_actor) then
    raise exception using errcode='P0001', message='Kullanıcı bulunamadı.', detail='404';
  end if;

  update squishy_shop.settings set default_packing=packing_amount where singleton;
  return jsonb_build_object('ok',true);
end $$;

revoke all on function public.shop_settings_write(integer,text,jsonb) from public, anon, authenticated;
grant execute on function public.shop_settings_write(integer,text,jsonb) to service_role;

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
        'id',p.id,'name',p.name,'date',p.date,'total',p.total,'actorId',p.actor_id,'paymentDate',c.date,'payerId',c.member_id,
        'lines',coalesce((
          select jsonb_agg(jsonb_build_object('productId',l.product_id,'productName',l.product_name,'quantity',l.quantity,'unitCost',l.unit_cost) order by l.id)
          from squishy_shop.lots l where l.purchase_id=p.id
        ),'[]'::jsonb)
      ) order by p.date desc,p.id desc)
      from squishy_shop.purchases p left join squishy_shop.cash c on c.kind='purchase' and c.entity_id=p.id
    ),'[]'::jsonb),
    'orders', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',o.id,'platform',o.platform,'reference',o.reference,'date',o.date,'status',o.status,'gross',o.gross,
        'discount',o.discount,'platformFee',o.platform_fee,'shipping',o.shipping,'packing',o.packing,'cost',o.cost,
        'expectedReceipt',o.gross-o.platform_fee,
        'profit',case when o.status in ('cancelled','returned') then 0 else o.gross-o.platform_fee-o.shipping-o.packing-o.cost end,
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
        select sum(gross-platform_fee-shipping-packing-cost) from squishy_shop.orders
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

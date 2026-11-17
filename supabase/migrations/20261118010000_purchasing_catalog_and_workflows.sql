begin;

alter table squishy_shop.purchases
  add column opening_payer_id integer references squishy_shop.members,
  add column supplier text,
  add column ordered_on date,
  add column rejected_units integer check (rejected_units >= 0);
alter table squishy_shop.orders
  add column shipping_payer_id integer references squishy_shop.members,
  add column packing_payer_id integer references squishy_shop.members;
alter table squishy_shop.orders
  drop constraint orders_net_after_shipping_check,
  add constraint orders_net_after_shipping_check check (
    net_after_shipping is null or (
      net_after_shipping >= -100000000 and net_after_shipping::bigint + shipping <= gross
      and platform_fee=0 and (shipping=0 or shipping_payer_id is not null)
    )
  );

create table squishy_shop.wholesale_prices (
  product_id integer not null references squishy_shop.products,
  supplier text not null,
  minimum_quantity integer not null check (minimum_quantity > 0),
  unit_cost integer not null check (unit_cost > 0),
  primary key (product_id, supplier, minimum_quantity)
);
alter table squishy_shop.wholesale_prices enable row level security;
grant select, insert, update, delete on squishy_shop.wholesale_prices to service_role;

alter table squishy_shop.settings add column catalog_key uuid unique;

-- All panel writers acquire the same transaction lock before touching data.
-- This makes the audit revision check and its inverse a single operation.
do $migration$
declare
  rpc text;
begin
  foreach rpc in array array['stock_write','inventory_write','cash_write','partnership_write','settings_write','order_delete']
  loop
    execute format('alter function public.shop_%I(integer,text,jsonb) set schema squishy_shop',rpc);
    execute format($wrapper$
      create function public.shop_%1$I(p_actor integer,p_action text,p_data jsonb)
      returns jsonb language plpgsql security invoker set search_path='' as $body$
      declare
        result jsonb;
      begin
        perform pg_advisory_xact_lock(149313,1);
        if %2$L='inventory_write' and p_action in ('purchase-payment','purchase-payment-edit') and exists(
          select 1 from squishy_shop.purchases where id=(p_data->>'id')::integer and opening_payer_id is not null
        ) then
          raise exception using errcode='P0001',message='Açılış stoğu için kasa ödemesi oluşturulamaz.',detail='409';
        end if;
        result := squishy_shop.shop_%1$I(p_actor,p_action,p_data);
        if %2$L='settings_write' then
          insert into squishy_shop.audit(action,entity_id,actor_id) values (p_action,1,p_actor);
        end if;
        if %2$L='stock_write' and p_action='purchase-edit' then
          update squishy_shop.purchases set
            supplier=case when p_data ? 'supplier' then p_data->>'supplier' else supplier end,
            ordered_on=case when p_data ? 'orderedOn' then (p_data->>'orderedOn')::date else ordered_on end,
            rejected_units=case when p_data ? 'rejectedUnits' then (p_data->>'rejectedUnits')::integer else rejected_units end,
            opening_payer_id=case when opening_payer_id is not null then coalesce((p_data->>'openingPayerId')::integer,opening_payer_id) end
          where id=(result->>'id')::integer;
          if exists(select 1 from squishy_shop.purchases where id=(result->>'id')::integer and ordered_on>date) then
            raise exception using errcode='P0001',message='Teslim tarihi sipariş tarihinden önce olamaz.',detail='400';
          end if;
        end if;
        return result;
      end $body$;
      revoke execute on function public.shop_%1$I(integer,text,jsonb) from public,anon,authenticated;
      grant execute on function public.shop_%1$I(integer,text,jsonb) to service_role;
    $wrapper$,rpc,rpc);
  end loop;
end $migration$;

create function squishy_shop.undo_last(p_actor integer,p_data jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  last_action squishy_shop.audit%rowtype;
  order_revision integer;
begin
  select * into last_action from squishy_shop.audit order by id desc limit 1;
  if last_action.id is distinct from (p_data->>'auditId')::integer or last_action.actor_id is distinct from p_actor then
    raise exception using errcode='P0001',message='Son işlem değişti. Paneli yenileyip tekrar kontrol edin.',detail='409';
  end if;
  case last_action.action
    when 'order' then
      select revision into order_revision from squishy_shop.orders where id=last_action.entity_id;
      perform public.shop_order_delete(p_actor,'order-delete',jsonb_build_object('id',last_action.entity_id,'revision',order_revision));
      update squishy_shop.stock set date=last_action.business_date
        where kind='adjustment' and reference='Silinen satış #'||last_action.entity_id and actor_id=p_actor;
    when 'expense','receipt','purchase-payment' then
      perform public.shop_cash_write(p_actor,'cash-delete',jsonb_build_object('id',last_action.entity_id,
        'kind',case when last_action.action='purchase-payment' then 'purchase' else last_action.action end));
    when 'stock-loss' then
      perform public.shop_inventory_write(p_actor,'stock-loss-delete',jsonb_build_object('id',last_action.entity_id,'date',last_action.business_date));
    when 'partner-transfer' then
      perform public.shop_partnership_write(p_actor,'partner-transfer-delete',jsonb_build_object('id',last_action.entity_id));
    when 'purchase' then
      if exists (select 1 from squishy_shop.lots where purchase_id=last_action.entity_id and quantity<>remaining) then
        raise exception using errcode='P0001',message='Bu alım stoğu kullanıldığı için geri alınamaz.',detail='409';
      end if;
      insert into squishy_shop.stock (product_id,product_name,date,kind,quantity,unit_cost,actor_id,reference)
        select l.product_id,l.product_name,p.date,'adjustment',-l.quantity,l.unit_cost,p_actor,p.name
        from squishy_shop.lots l join squishy_shop.purchases p on p.id=l.purchase_id where p.id=last_action.entity_id;
      delete from squishy_shop.cash where kind='purchase' and entity_id=last_action.entity_id;
      delete from squishy_shop.lots where purchase_id=last_action.entity_id;
      delete from squishy_shop.purchases where id=last_action.entity_id;
    else
      raise exception using errcode='P0001',message='Son işlem geri almaya uygun değil.',detail='409';
  end case;
  insert into squishy_shop.audit(action,entity_id,actor_id,business_date)
  values ('undo',last_action.entity_id,p_actor,last_action.business_date);
  return jsonb_build_object('ok',true,'id',last_action.entity_id);
end $$;
revoke execute on function squishy_shop.undo_last(integer,jsonb) from public,anon,authenticated;
grant execute on function squishy_shop.undo_last(integer,jsonb) to service_role;

alter function public.shop_read(text,jsonb) set schema squishy_shop;

create function public.shop_read(p_action text,p_data jsonb)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare
  state jsonb;
  purchases jsonb;
  orders jsonb;
  sale_costs jsonb;
  sale_cost_total bigint;
  movements jsonb;
  catalog_key uuid;
begin
  if p_action in ('catalog','catalog-photo') then
    select s.catalog_key into catalog_key from squishy_shop.settings s where s.singleton;
    if catalog_key is null or catalog_key::text is distinct from p_data->>'key' then return null; end if;
    if p_action='catalog-photo' then
      return (select to_jsonb(p.photo) from squishy_shop.products p where p.id=(p_data->>'id')::integer
        and exists(select 1 from squishy_shop.lots l where l.product_id=p.id and l.remaining>0));
    end if;
    return coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'hasPhoto',p.photo is not null,
      'dolapListPrice',p.dolap_list_price,'gardropsListPrice',p.gardrops_list_price) order by p.name,p.id)
      from squishy_shop.products p where exists(select 1 from squishy_shop.lots l where l.product_id=p.id and l.remaining>0)),'[]'::jsonb);
  end if;

  state := squishy_shop.shop_read(p_action,p_data);
  if p_action<>'state' then return state; end if;
  select coalesce(jsonb_agg(value || jsonb_build_object('openingPayerId',p.opening_payer_id,'supplier',p.supplier,
    'orderedOn',p.ordered_on,'rejectedUnits',p.rejected_units) order by position),'[]'::jsonb)
    into purchases from jsonb_array_elements(state->'purchases') with ordinality as items(value,position)
    join squishy_shop.purchases p on p.id=(value->>'id')::integer;
  select coalesce(jsonb_agg(value || jsonb_build_object('shippingPayerId',o.shipping_payer_id,'packingPayerId',o.packing_payer_id,
      'expectedReceipt',case when o.net_after_shipping is not null then o.net_after_shipping + o.shipping::bigint else o.gross-o.platform_fee end)
    order by position),'[]'::jsonb)
    into orders from jsonb_array_elements(state->'orders') with ordinality as items(value,position)
    join squishy_shop.orders o on o.id=(value->>'id')::integer;
  select coalesce(jsonb_agg(jsonb_build_object('kind','sale-cost','id',o.id,'date',o.date,'amount',-fee.amount,
      'memberId',fee.payer_id,'actorId',o.actor_id,'description',fee.label || ' · ' || o.platform || ' #' || o.id)
      order by o.date desc,o.id desc,fee.label),'[]'::jsonb),coalesce(sum(fee.amount::bigint),0)
    into sale_costs,sale_cost_total
    from squishy_shop.orders o
    cross join lateral (values ('Kargo',o.shipping,o.shipping_payer_id),('Paketleme',o.packing,o.packing_payer_id)) fee(label,amount,payer_id)
    where fee.payer_id is not null and fee.amount>0;
  select coalesce(jsonb_agg(value order by value->>'date' desc,(value->>'id')::integer desc,value->>'kind',position),'[]'::jsonb)
    into movements from jsonb_array_elements(state->'cash' || sale_costs) with ordinality as items(value,position);
  return state || jsonb_build_object(
    'purchases',purchases,'orders',orders,'cash',movements,
    'summary',state->'summary' || jsonb_build_object('cashBalance',(state->'summary'->>'cashBalance')::bigint-sale_cost_total),
    'catalogKey',(select s.catalog_key from squishy_shop.settings s where s.singleton),
    'wholesalePrices',coalesce((select jsonb_agg(jsonb_build_object('productId',w.product_id,'supplier',w.supplier,
      'minimumQuantity',w.minimum_quantity,'unitCost',w.unit_cost) order by w.product_id,w.supplier,w.minimum_quantity)
      from squishy_shop.wholesale_prices w),'[]'::jsonb)
  );
end $$;
revoke execute on function public.shop_read(text,jsonb) from public,anon,authenticated;
grant execute on function public.shop_read(text,jsonb) to service_role;



create or replace function public.shop_write(p_actor integer, p_action text, p_data jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  item_id integer := (p_data->>'id')::integer;
  day date := (p_data->>'date')::date;
  member_id integer := (p_data->>'payerId')::integer;
  order_row squishy_shop.orders%rowtype;
  order_line squishy_shop.order_lines%rowtype;
  material squishy_shop.packaging_materials%rowtype;
  purchase_row squishy_shop.purchases%rowtype;
  product_row squishy_shop.products%rowtype;
  lot squishy_shop.lots%rowtype;
  line jsonb;
  quantity integer;
  remaining integer;
  used_quantity integer;
  unit_amount integer;
  platform_list_price integer;
  bundle_total bigint := (p_data->>'saleTotal')::bigint;
  net_after_shipping_amount integer := (p_data->>'netAfterShipping')::integer;
  bundle_list_total bigint;
  bundle_quantity bigint;
  weight_total bigint;
  cumulative_weight bigint := 0;
  cumulative_amount bigint := 0;
  allocated_amount bigint;
  line_amount bigint;
  higher_price_units integer;
  higher_price_in_lot integer;
  old_lines jsonb := '[]'::jsonb;
  allocation record;
  previous_platform text;
  preserve_prices boolean := false;
  order_gross bigint := 0;
  order_discount bigint := 0;
  order_cost bigint := 0;
  return_line jsonb;
  restore_by_product jsonb := '{}'::jsonb;
  restore_key text;
  restore_quantity integer;
  allocated_quantity bigint;
  new_status text := p_data->>'status';
  sellable boolean := (p_data->>'sellable')::boolean;
begin
  perform pg_advisory_xact_lock(149313,1);
  if not exists (select 1 from squishy_shop.members where id = p_actor) then
    raise exception using errcode='P0001', message='Kullanıcı bulunamadı.', detail='404';
  end if;

  if p_action='order-edit' then
    select * into order_row from squishy_shop.orders where id=item_id for update;
    if not found then
      raise exception using errcode='P0001', message='Sipariş bulunamadı.', detail='404';
    end if;
    if order_row.status not in ('pending','packed') then
      raise exception using errcode='P0001', message='İptal ve iade edilmiş satış düzenlenemez.', detail='409';
    end if;
    if order_row.revision is distinct from (p_data->>'revision')::integer then
      raise exception using errcode='P0001', message='Satış değişti. Düzenlemeyi kapatıp güncel kaydı açın.', detail='409';
    end if;
    previous_platform := order_row.platform;
    select coalesce(jsonb_agg(to_jsonb(l) order by l.id),'[]'::jsonb) into old_lines
    from squishy_shop.order_lines l where l.order_id=item_id;
    preserve_prices := bundle_total=order_row.gross and p_data->>'platform'=order_row.platform and not exists (
      select 1 from (
        select (v->>'product_id')::integer as product_id,sum((v->>'quantity')::integer) as quantity
        from jsonb_array_elements(old_lines) v group by (v->>'product_id')::integer
      ) old full join (
        select (v->>'productId')::integer as product_id,(v->>'quantity')::integer as quantity
        from jsonb_array_elements(p_data->'lines') v
      ) new using (product_id)
      where old.quantity is distinct from new.quantity
    );
  end if;

  -- Serialize inventory writers by product, using a consistent lock order.
  if p_action in ('purchase','order','order-edit') then
    perform p.id from squishy_shop.products p
    where p.id in (
      select (value->>'productId')::integer from jsonb_array_elements(p_data->'lines')
      union select (value->>'product_id')::integer from jsonb_array_elements(old_lines)
    )
    order by p.id for update;
  end if;

  if exists (
    select 1 from (values ((p_data->>'openingPayerId')::integer),((p_data->>'shippingPayerId')::integer),
      ((p_data->>'packingPayerId')::integer)) payers(id)
    where payers.id is not null and not exists(select 1 from squishy_shop.members m where m.id=payers.id)
  ) then
    raise exception using errcode='P0001',message='Ödeyen ortak bulunamadı.',detail='404';
  end if;

  case p_action
    when 'undo' then
      return squishy_shop.undo_last(p_actor,p_data);

    when 'catalog-settings' then
      update squishy_shop.settings set catalog_key=case when (p_data->>'enabled')::boolean then gen_random_uuid() end
        where singleton;
      item_id := 1;

    when 'wholesale-price','wholesale-price-delete' then
      item_id := (p_data->>'productId')::integer;
      if p_action='wholesale-price' then
        if not exists(select 1 from squishy_shop.products where id=item_id) then
          raise exception using errcode='P0001',message='Ürün bulunamadı.',detail='404';
        end if;
        insert into squishy_shop.wholesale_prices(product_id,supplier,minimum_quantity,unit_cost)
        values(item_id,p_data->>'supplier',(p_data->>'minimumQuantity')::integer,(p_data->>'unitCost')::integer)
        on conflict(product_id,supplier,minimum_quantity) do update set unit_cost=excluded.unit_cost;
      else
        delete from squishy_shop.wholesale_prices where product_id=item_id and supplier=p_data->>'supplier'
          and minimum_quantity=(p_data->>'minimumQuantity')::integer;
        if not found then
          raise exception using errcode='P0001',message='Fiyat kademesi bulunamadı.',detail='404';
        end if;
      end if;

    when 'product' then
      if item_id is null then
        insert into squishy_shop.products (name,photo,dolap_list_price,gardrops_list_price,low_threshold,first_partner_share)
        values (p_data->>'name',p_data->>'photo',
          coalesce(p_data->>'dolapListPrice',p_data->>'listPrice')::integer,
          coalesce(p_data->>'gardropsListPrice',p_data->>'listPrice')::integer,
          (p_data->>'lowThreshold')::integer,(p_data->>'firstPartnerShare')::smallint)
        returning id into item_id;
      else
        update squishy_shop.products p
        set name=p_data->>'name',
            photo=case when p_data ? 'photo' then p_data->>'photo' else p.photo end,
            photo_version=p.photo_version + case when p_data ? 'photo' and (p_data->>'photo') is distinct from p.photo then 1 else 0 end,
            dolap_list_price=coalesce(p_data->>'dolapListPrice',p_data->>'listPrice')::integer,
            gardrops_list_price=coalesce((p_data->>'gardropsListPrice')::integer,p.gardrops_list_price),
            low_threshold=(p_data->>'lowThreshold')::integer,
            first_partner_share=case when p_data ? 'firstPartnerShare' then (p_data->>'firstPartnerShare')::smallint else p.first_partner_share end
        where p.id=item_id;
        if not found then
          raise exception using errcode='P0001', message='Ürün bulunamadı.', detail='404';
        end if;
      end if;

    when 'purchase', 'purchase-payment' then
      if p_action='purchase' then
        insert into squishy_shop.purchases (name,date,total,actor_id,opening_payer_id,supplier,ordered_on,rejected_units)
        values (p_data->>'name',day,(p_data->>'total')::integer,p_actor,(p_data->>'openingPayerId')::integer,
          p_data->>'supplier',(p_data->>'orderedOn')::date,(p_data->>'rejectedUnits')::integer)
        returning * into purchase_row;
        item_id := purchase_row.id;

        for line in select value from jsonb_array_elements(p_data->'lines')
        loop
          select * into product_row from squishy_shop.products where id=(line->>'productId')::integer;
          if not found then
            raise exception using errcode='P0001', message='Ürün bulunamadı.', detail='404';
          end if;
          quantity := (line->>'quantity')::integer;
          unit_amount := (line->>'unitCost')::integer;
          insert into squishy_shop.lots (purchase_id,product_id,product_name,quantity,remaining,unit_cost,first_partner_share)
          values (item_id,product_row.id,product_row.name,quantity,quantity,unit_amount,coalesce((line->>'firstPartnerShare')::smallint,product_row.first_partner_share));
          insert into squishy_shop.stock (product_id,product_name,date,kind,quantity,unit_cost,actor_id,reference)
          values (product_row.id,product_row.name,day,'purchase',quantity,unit_amount,p_actor,purchase_row.name);
        end loop;

        if purchase_row.ordered_on>purchase_row.date then
          raise exception using errcode='P0001',message='Teslim tarihi sipariş tarihinden önce olamaz.',detail='400';
        end if;
        if purchase_row.opening_payer_id is not null then
          if jsonb_typeof(p_data->'payment')='object' then
            raise exception using errcode='P0001',message='Açılış stoğu için kasa ödemesi oluşturulamaz.',detail='400';
          end if;
          insert into squishy_shop.audit(action,entity_id,actor_id,business_date)
          values ('purchase',item_id,p_actor,purchase_row.date);
          return jsonb_build_object('ok',true,'id',item_id);
        end if;
        day := (p_data->'payment'->>'date')::date;
        member_id := (p_data->'payment'->>'payerId')::integer;
      else
        select * into purchase_row from squishy_shop.purchases where id=item_id for update;
        if not found then
          raise exception using errcode='P0001', message='Alış kaydı bulunamadı.', detail='404';
        end if;
      end if;

      if member_id is not null or (p_action='purchase' and p_data->'payment' ? 'payments') then
        perform public.shop_inventory_write(p_actor,'purchase-payment',
          jsonb_build_object('id',item_id,'date',day,'payerId',member_id)
            || case when p_action='purchase' then coalesce(p_data->'payment','{}'::jsonb) else p_data end);
      end if;

    when 'order', 'order-edit' then
      if p_action='order-edit' then
        for order_line in select * from squishy_shop.order_lines where order_id=item_id order by id
        loop
          update squishy_shop.lots l set remaining=l.remaining+order_line.quantity where l.id=order_line.lot_id;
          insert into squishy_shop.stock (product_id,product_name,date,kind,quantity,unit_cost,actor_id,reference)
          values (order_line.product_id,order_line.product_name,order_row.date,
            'adjustment',order_line.quantity,order_line.unit_cost,p_actor,order_row.reference);
        end loop;
        delete from squishy_shop.order_lines where order_id=item_id;
      end if;
      if bundle_total is not null then
        select coalesce(sum((l.value->>'quantity')::bigint * coalesce((
                 select (v->>'list_price')::integer from jsonb_array_elements(old_lines) v
                 where (v->>'product_id')::integer=p.id and previous_platform=p_data->>'platform' limit 1
               ), case p_data->>'platform' when 'Dolap' then p.dolap_list_price else p.gardrops_list_price end)),0),
               coalesce(sum((l.value->>'quantity')::bigint),0)
        into bundle_list_total,bundle_quantity
        from jsonb_array_elements(p_data->'lines') l
        join squishy_shop.products p on p.id=(l.value->>'productId')::integer;
        weight_total := coalesce(nullif(bundle_list_total,0),bundle_quantity);
      end if;

      if p_action='order' then
        insert into squishy_shop.orders (platform,reference,date,platform_fee,shipping,packing,actor_id)
        values (p_data->>'platform',p_data->>'reference',day,
          (p_data->>'platformFee')::integer,(p_data->>'shipping')::integer,(p_data->>'packing')::integer,p_actor)
        returning * into order_row;
        item_id := order_row.id;
      else
        update squishy_shop.orders set platform=p_data->>'platform',reference=p_data->>'reference',date=day,
          platform_fee=(p_data->>'platformFee')::integer,shipping=(p_data->>'shipping')::integer,
          packing=(p_data->>'packing')::integer,net_after_shipping=null,revision=revision+1
        where id=item_id returning * into order_row;
        update squishy_shop.cash set description=order_row.reference where kind='receipt' and entity_id=item_id;
      end if;

      for line in select value from jsonb_array_elements(p_data->'lines')
      loop
        select * into product_row from squishy_shop.products where id=(line->>'productId')::integer;
        if not found then
          raise exception using errcode='P0001', message='Ürün bulunamadı.', detail='404';
        end if;
        quantity := (line->>'quantity')::integer;
        platform_list_price := case order_row.platform
          when 'Dolap' then product_row.dolap_list_price
          when 'Gardrops' then product_row.gardrops_list_price
        end;
        if previous_platform=order_row.platform then
          platform_list_price := coalesce((
            select (v->>'list_price')::integer from jsonb_array_elements(old_lines) v
            where (v->>'product_id')::integer=product_row.id limit 1
          ),platform_list_price);
        end if;
        if bundle_total is null then
          unit_amount := (line->>'agreedPrice')::integer;
          line_amount := quantity::bigint * unit_amount;
          higher_price_units := 0;
        else
          -- Allocate against cumulative list-price weights so the final sum matches to the cent.
          cumulative_weight := cumulative_weight + quantity::bigint *
            case when bundle_list_total=0 then 1 else platform_list_price end;
          if preserve_prices then
            select sum((v->>'quantity')::bigint * (v->>'agreed_price')::integer) into line_amount
            from jsonb_array_elements(old_lines) v where (v->>'product_id')::integer=product_row.id;
          else
            allocated_amount := round(bundle_total::numeric * cumulative_weight / weight_total)::bigint;
            line_amount := allocated_amount - cumulative_amount;
            cumulative_amount := allocated_amount;
          end if;
          unit_amount := (line_amount / quantity)::integer;
          higher_price_units := (line_amount % quantity)::integer;
        end if;
        remaining := quantity;
        order_gross := order_gross + line_amount;
        order_discount := order_discount + greatest(0, quantity::bigint * platform_list_price - line_amount);

        for allocation in
          with original as (
            select (v->>'lot_id')::integer as lot_id,(v->>'first_partner_share')::smallint as share,
              sum((v->>'quantity')::integer)::integer as quantity,
              min((v->>'id')::integer) as position
            from jsonb_array_elements(old_lines) v
            where (v->>'product_id')::integer=product_row.id
            group by (v->>'lot_id')::integer,(v->>'first_partner_share')::smallint
          ), segments as (
            select l.id,l.unit_cost,o.share,o.quantity,p.date,0 as priority,o.position
            from original o join squishy_shop.lots l on l.id=o.lot_id
            join squishy_shop.purchases p on p.id=l.purchase_id
            union all
            select l.id,l.unit_cost,l.first_partner_share,
              l.remaining-coalesce((select sum(o.quantity)::integer from original o where o.lot_id=l.id),0),
              p.date,1,l.id
            from squishy_shop.lots l join squishy_shop.purchases p on p.id=l.purchase_id
            where l.product_id=product_row.id and l.remaining>0
          )
          select s.* from segments s where s.quantity>0 and (line->>'lotId' is null or s.id=(line->>'lotId')::integer) order by s.priority,s.date,s.id,s.position
        loop
          used_quantity := least(remaining,allocation.quantity);
          update squishy_shop.lots l set remaining=l.remaining-used_quantity where l.id=allocation.id;
          -- Units carrying a remainder cent retain their actual price in the existing FIFO lines.
          higher_price_in_lot := least(higher_price_units,used_quantity);
          insert into squishy_shop.order_lines (order_id,product_id,product_name,lot_id,quantity,list_price,agreed_price,unit_cost,first_partner_share)
          select item_id,product_row.id,product_row.name,allocation.id,split.quantity,platform_list_price,split.price,allocation.unit_cost,allocation.share
          from (values (higher_price_in_lot,unit_amount+1), (used_quantity-higher_price_in_lot,unit_amount)) as split(quantity,price)
          where split.quantity>0;
          higher_price_units := higher_price_units-higher_price_in_lot;
          insert into squishy_shop.stock (product_id,product_name,date,kind,quantity,unit_cost,actor_id,reference)
          values (product_row.id,product_row.name,day,'sale',-used_quantity,allocation.unit_cost,p_actor,order_row.reference);
          order_cost := order_cost + used_quantity::bigint * allocation.unit_cost;
          remaining := remaining - used_quantity;
          exit when remaining=0;
        end loop;

        if remaining>0 then
          raise exception using errcode='P0001', message=case when line->>'lotId' is null then format('%s için yeterli stok yok.',product_row.name)
            else format('%s için seçilen partide yeterli stok yok.',product_row.name) end, detail='409';
        end if;
      end loop;

      if net_after_shipping_amount::bigint + coalesce((p_data->>'shipping')::integer,0) > order_gross then
        raise exception using errcode='P0001', message='Net tutar satış toplamını aşamaz.', detail='400';
      end if;
      update squishy_shop.orders
      set gross=order_gross,discount=order_discount,cost=order_cost,net_after_shipping=net_after_shipping_amount,
          shipping_payer_id=case when p_data ? 'shippingPayerId' then (p_data->>'shippingPayerId')::integer
            when net_after_shipping_amount is null and shipping>0 then shipping_payer_id end,
          packing_payer_id=case when p_data ? 'packingPayerId' then (p_data->>'packingPayerId')::integer
            when packing>0 then packing_payer_id end
      where id=item_id;

    when 'order-status', 'receipt' then
      select * into order_row from squishy_shop.orders where id=item_id for update;
      if not found then
        raise exception using errcode='P0001', message='Sipariş bulunamadı.', detail='404';
      end if;

      if p_action='receipt' then
        if order_row.status in ('cancelled','returned') then
          raise exception using errcode='P0001', message='Kapanan siparişe tahsilat eklenemez.', detail='409';
        end if;
        member_id := (p_data->>'recipientId')::integer;
        if not exists (select 1 from squishy_shop.members where id=member_id) then
          raise exception using errcode='P0001', message='Tahsilatı alan kullanıcı bulunamadı.', detail='404';
        end if;
        insert into squishy_shop.cash (kind,entity_id,date,amount,member_id,actor_id,description)
        values ('receipt',item_id,day,(p_data->>'amount')::integer,member_id,p_actor,order_row.reference)
        on conflict (kind,entity_id) do nothing;
        if not found then
          raise exception using errcode='P0001', message='Bu siparişin tahsilatı zaten kaydedildi.', detail='409';
        end if;

      else
        if new_status='returned' and p_data ? 'returns' then
          sellable := jsonb_array_length(p_data->'returns') > 0;
          for return_line in select value from jsonb_array_elements(p_data->'returns')
          loop
            restore_key := ((return_line->>'productId')::integer)::text;
            restore_quantity := (return_line->>'quantity')::integer;
            select coalesce(sum(l.quantity),0) into allocated_quantity
            from squishy_shop.order_lines l
            where l.order_id=item_id and l.product_id=restore_key::integer;
            if restore_quantity is null or restore_quantity < 1 or restore_quantity > allocated_quantity
              or restore_by_product ? restore_key then
              raise exception using errcode='P0001', message='İade adedi siparişteki ürün adedini aşamaz ve her ürün bir kez yazılmalıdır.', detail='400';
            end if;
            restore_by_product := restore_by_product || jsonb_build_object(restore_key,restore_quantity);
          end loop;
        end if;

        if not (
          (new_status='packed' and order_row.status='pending') or
          (new_status='cancelled' and order_row.status in ('pending','packed')) or
          (new_status='returned' and order_row.status='packed' and sellable is not null)
        ) then
          raise exception using errcode='P0001', message='Sipariş bu duruma geçirilemez.', detail='409';
        end if;

        if new_status='cancelled' or (new_status='returned' and sellable) then
          perform p.id from squishy_shop.products p
          where p.id in (select l.product_id from squishy_shop.order_lines l where l.order_id=item_id)
          order by p.id for update;

          for order_line in select * from squishy_shop.order_lines where order_id=item_id order by id
          loop
            used_quantity := order_line.quantity;
            if new_status='returned' and p_data ? 'returns' then
              restore_key := order_line.product_id::text;
              restore_quantity := coalesce((restore_by_product->>restore_key)::integer,0);
              if restore_quantity=0 then continue; end if;
              used_quantity := least(restore_quantity,order_line.quantity);
              restore_by_product := restore_by_product || jsonb_build_object(restore_key,restore_quantity-used_quantity);
            end if;
            update squishy_shop.lots l set remaining=l.remaining+used_quantity where l.id=order_line.lot_id;
            if new_status='returned' then
              update squishy_shop.order_lines set returned_quantity=used_quantity where id=order_line.id;
            end if;
            insert into squishy_shop.stock (product_id,product_name,date,kind,quantity,unit_cost,actor_id,reference)
            values (order_line.product_id,order_line.product_name,day,new_status,used_quantity,order_line.unit_cost,p_actor,order_row.reference);
          end loop;
        end if;

        if new_status='packed' then
          for material in select * from squishy_shop.packaging_materials where per_order>0 order by id for update
          loop
            if material.quantity<material.per_order then
              raise exception using errcode='P0001',message=format('%s stoğu yetersiz. Ambalaj Stoku ekranından malzeme ekleyin.',material.name),detail='409';
            end if;
            update squishy_shop.packaging_materials set quantity=material.quantity-material.per_order where id=material.id;
            insert into squishy_shop.packaging_movements(material_id,date,quantity,order_id,note,actor_id)
            values(material.id,day,-material.per_order,item_id,'Sipariş paketlendi',p_actor);
          end loop;
        end if;
        update squishy_shop.orders set status=new_status,return_sellable=case when new_status='returned' then sellable end
        where id=item_id;
      end if;

    when 'expense' then
      if not exists (select 1 from squishy_shop.members where id=member_id) then
        raise exception using errcode='P0001', message='Ödeyen kullanıcı bulunamadı.', detail='404';
      end if;
      unit_amount := (p_data->>'amount')::integer;
      insert into squishy_shop.expenses (category,amount,date,payer_id,actor_id,note,first_partner_share)
      values (p_data->>'category',unit_amount,day,member_id,p_actor,coalesce(p_data->>'note',''),(p_data->>'firstPartnerShare')::smallint)
      returning id into item_id;
      insert into squishy_shop.cash (kind,entity_id,date,amount,member_id,actor_id,description)
      values ('expense',item_id,day,-unit_amount,member_id,p_actor,p_data->>'category');

    else
      raise exception using errcode='P0001', message='Geçersiz işlem.', detail='400';
  end case;

  insert into squishy_shop.audit (action,entity_id,actor_id,business_date,status)
  values (p_action,item_id,p_actor,case when p_action='purchase' then purchase_row.date else day end,new_status);
  return jsonb_build_object('ok',true,'id',item_id);
end $$;

notify pgrst, 'reload schema';
commit;

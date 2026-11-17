begin;

create table squishy_shop.purchase_payment_shares (
  purchase_id integer not null references squishy_shop.purchases,
  kind text not null default 'purchase' check (kind='purchase'),
  member_id integer not null references squishy_shop.members,
  amount integer not null check (amount>=0),
  primary key (purchase_id,member_id),
  foreign key (kind,purchase_id) references squishy_shop.cash(kind,entity_id) on delete cascade
);
insert into squishy_shop.purchase_payment_shares (purchase_id,member_id,amount)
select entity_id,member_id,-amount from squishy_shop.cash where kind='purchase';

create function squishy_shop.sync_purchase_payment_shares()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if new.kind<>'purchase' then return new; end if;
  if not exists(select 1 from squishy_shop.purchase_payment_shares where purchase_id=new.entity_id) then
    insert into squishy_shop.purchase_payment_shares (purchase_id,member_id,amount) values (new.entity_id,new.member_id,-new.amount);
  elsif tg_op='UPDATE' then
    if old.member_id<>new.member_id and (
      select count(*) from squishy_shop.purchase_payment_shares where purchase_id=new.entity_id
    )=1 then
      update squishy_shop.purchase_payment_shares set member_id=new.member_id where purchase_id=new.entity_id;
    end if;
    if old.amount<>new.amount then
      with weights as (
        select member_id,
          sum(amount) over(order by member_id) as cumulative,
          sum(amount) over(order by member_id rows between unbounded preceding and 1 preceding) as previous,
          sum(amount) over() as total
        from squishy_shop.purchase_payment_shares where purchase_id=new.entity_id
      )
      update squishy_shop.purchase_payment_shares s
      set amount=round(-new.amount::numeric*w.cumulative/w.total)-round(-new.amount::numeric*coalesce(w.previous,0)/w.total)
      from weights w where s.purchase_id=new.entity_id and s.member_id=w.member_id;
      delete from squishy_shop.purchase_payment_shares where purchase_id=new.entity_id and amount=0;
      -- If rounding leaves one payer, keep the parent cash account aligned with that payer.
      update squishy_shop.cash c set member_id=s.member_id
      from squishy_shop.purchase_payment_shares s
      where c.kind='purchase' and c.entity_id=new.entity_id and s.purchase_id=c.entity_id
        and c.member_id is distinct from s.member_id
        and (select count(*) from squishy_shop.purchase_payment_shares where purchase_id=new.entity_id)=1;
    end if;
  end if;
  return new;
end $$;
revoke all on function squishy_shop.sync_purchase_payment_shares() from public,anon,authenticated;
grant execute on function squishy_shop.sync_purchase_payment_shares() to service_role;
create trigger sync_purchase_payment_shares after insert or update on squishy_shop.cash
for each row execute function squishy_shop.sync_purchase_payment_shares();

create table squishy_shop.stock_losses (
  id integer generated always as identity primary key,
  product_id integer not null references squishy_shop.products,
  product_name text not null,
  quantity integer not null check (quantity>0),
  date date not null,
  reason text not null check (reason in ('damaged','lost')),
  note text not null,
  actor_id integer not null references squishy_shop.members
);
create table squishy_shop.stock_loss_lines (
  id integer generated always as identity primary key,
  loss_id integer not null references squishy_shop.stock_losses on delete cascade,
  lot_id integer not null references squishy_shop.lots,
  quantity integer not null check (quantity>0),
  unit_cost integer not null check (unit_cost>=0),
  first_partner_share smallint check (first_partner_share between 0 and 100)
);
create index on squishy_shop.stock_loss_lines(lot_id);

create table squishy_shop.packaging_materials (
  id integer generated always as identity primary key,
  name text not null,
  quantity integer not null default 0 check (quantity>=0),
  low_threshold integer not null check (low_threshold>=0),
  per_order integer not null check (per_order>=0),
  revision integer not null default 0
);
create table squishy_shop.packaging_movements (
  id integer generated always as identity primary key,
  material_id integer not null references squishy_shop.packaging_materials,
  date date not null,
  quantity integer not null check (quantity<>0),
  order_id integer references squishy_shop.orders,
  note text not null,
  actor_id integer not null references squishy_shop.members
);
create index on squishy_shop.packaging_movements(material_id,id);
alter table squishy_shop.stock drop constraint stock_kind_check;
alter table squishy_shop.stock add constraint stock_kind_check check (kind in ('purchase','sale','cancelled','returned','adjustment','loss'));

do $permissions$
declare name text;
begin
  foreach name in array array['purchase_payment_shares','stock_losses','stock_loss_lines','packaging_materials','packaging_movements']
  loop
    execute format('alter table squishy_shop.%I enable row level security',name);
    execute format('revoke all on squishy_shop.%I from public,anon,authenticated',name);
    execute format('grant select,insert,update,delete on squishy_shop.%I to service_role',name);
  end loop;
end $permissions$;
revoke all on sequence squishy_shop.stock_losses_id_seq,squishy_shop.stock_loss_lines_id_seq,squishy_shop.packaging_materials_id_seq,squishy_shop.packaging_movements_id_seq from public,anon,authenticated;
grant usage on sequence squishy_shop.stock_losses_id_seq,squishy_shop.stock_loss_lines_id_seq,squishy_shop.packaging_materials_id_seq,squishy_shop.packaging_movements_id_seq to service_role;

create function public.shop_inventory_write(p_actor integer,p_action text,p_data jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  item_id integer := (p_data->>'id')::integer;
  day date := (p_data->>'date')::date;
  purchase_row squishy_shop.purchases%rowtype;
  payments jsonb := p_data->'payments';
  payment jsonb;
  loss squishy_shop.stock_losses%rowtype;
  lot squishy_shop.lots%rowtype;
  material squishy_shop.packaging_materials%rowtype;
  product_id_value integer := (p_data->>'productId')::integer;
  quantity_value integer := (p_data->>'quantity')::integer;
  remaining_quantity integer := quantity_value;
  used_quantity integer;
  product_name_value text;
begin
  if not exists(select 1 from squishy_shop.members where id=p_actor) then
    raise exception using errcode='P0001',message='Kullanıcı bulunamadı.',detail='404';
  end if;
  case p_action
    when 'purchase-payment','purchase-payment-edit' then
      select * into purchase_row from squishy_shop.purchases where id=item_id for update;
      if not found then raise exception using errcode='P0001',message='Alım bulunamadı.',detail='404'; end if;
      perform entity_id from squishy_shop.cash where kind='purchase' and entity_id=item_id for update;
      if (p_action='purchase-payment')=exists(select 1 from squishy_shop.cash where kind='purchase' and entity_id=item_id) then
        raise exception using errcode='P0001',message='Alımın ödeme durumu değişti. Güncel kaydı açın.',detail='409';
      end if;
      payments := coalesce(payments,jsonb_build_array(jsonb_build_object('payerId',p_data->'payerId','amount',purchase_row.total)));
      if jsonb_array_length(payments) not between 1 and 2 or (
        select sum((value->>'amount')::bigint) from jsonb_array_elements(payments)
      ) is distinct from purchase_row.total::bigint or exists(
        select 1 from jsonb_array_elements(payments) p where (p.value->>'amount')::integer<=0
          or not exists(select 1 from squishy_shop.members m where m.id=(p.value->>'payerId')::integer)
      ) or (select count(distinct value->>'payerId') from jsonb_array_elements(payments))<>jsonb_array_length(payments) then
        raise exception using errcode='P0001',message='Ortakların ödemeleri alım toplamıyla eşleşmeli.',detail='400';
      end if;
      delete from squishy_shop.purchase_payment_shares where purchase_id=item_id;
      insert into squishy_shop.cash (kind,entity_id,date,amount,member_id,actor_id,description)
      values ('purchase',item_id,day,-purchase_row.total,(payments->0->>'payerId')::integer,p_actor,purchase_row.name)
      on conflict(kind,entity_id) do update set date=excluded.date,amount=excluded.amount,member_id=excluded.member_id;
      delete from squishy_shop.purchase_payment_shares where purchase_id=item_id;
      for payment in select value from jsonb_array_elements(payments)
      loop
        insert into squishy_shop.purchase_payment_shares(purchase_id,member_id,amount)
        values(item_id,(payment->>'payerId')::integer,(payment->>'amount')::integer);
      end loop;
    when 'stock-loss' then
      select name into product_name_value from squishy_shop.products where id=product_id_value for update;
      if not found then raise exception using errcode='P0001',message='Ürün bulunamadı.',detail='404'; end if;
      if quantity_value is null or quantity_value<1 then raise exception using errcode='P0001',message='Geçerli adet girin.',detail='400'; end if;
      insert into squishy_shop.stock_losses(product_id,product_name,quantity,date,reason,note,actor_id)
      values(product_id_value,product_name_value,quantity_value,day,p_data->>'reason',coalesce(p_data->>'note',''),p_actor)
      returning id into item_id;
      for lot in
        select l.* from squishy_shop.lots l join squishy_shop.purchases p on p.id=l.purchase_id
        where l.product_id=product_id_value and l.remaining>0 order by p.date,l.id
      loop
        used_quantity := least(remaining_quantity,lot.remaining);
        update squishy_shop.lots set remaining=lot.remaining-used_quantity where id=lot.id;
        if lot.first_partner_share is null then
          raise exception using errcode='P0001',message='Önce bu ürünün stok alımındaki ortaklık payını tamamlayın.',detail='409';
        end if;
        insert into squishy_shop.stock_loss_lines(loss_id,lot_id,quantity,unit_cost,first_partner_share)
        values(item_id,lot.id,used_quantity,lot.unit_cost,lot.first_partner_share);
        insert into squishy_shop.stock(product_id,product_name,date,kind,quantity,unit_cost,actor_id,reference)
        values(product_id_value,product_name_value,day,'loss',-used_quantity,lot.unit_cost,p_actor,'#'||item_id||' '||(p_data->>'reason'));
        remaining_quantity := remaining_quantity-used_quantity;
        exit when remaining_quantity=0;
      end loop;
      if remaining_quantity>0 then raise exception using errcode='P0001',message='Yeterli stok yok.',detail='409'; end if;
    when 'stock-loss-delete' then
      select * into loss from squishy_shop.stock_losses where id=item_id for update;
      if not found then raise exception using errcode='P0001',message='Hasar/kayıp kaydı bulunamadı.',detail='404'; end if;
      perform id from squishy_shop.products where id=loss.product_id for update;
      for lot in select l.* from squishy_shop.lots l join squishy_shop.stock_loss_lines x on x.lot_id=l.id where x.loss_id=item_id order by l.id
      loop
        select quantity into used_quantity from squishy_shop.stock_loss_lines where loss_id=item_id and lot_id=lot.id;
        update squishy_shop.lots set remaining=lot.remaining+used_quantity where id=lot.id;
        insert into squishy_shop.stock(product_id,product_name,date,kind,quantity,unit_cost,actor_id,reference)
        values(loss.product_id,loss.product_name,day,'adjustment',used_quantity,lot.unit_cost,p_actor,'Hasar/kayıp geri alma #'||item_id);
      end loop;
      delete from squishy_shop.stock_losses where id=item_id;
    when 'packaging-material' then
      if item_id is null then
        insert into squishy_shop.packaging_materials(name,low_threshold,per_order)
        values(p_data->>'name',(p_data->>'lowThreshold')::integer,(p_data->>'perOrder')::integer)
        returning id into item_id;
      else
        update squishy_shop.packaging_materials set name=p_data->>'name',low_threshold=(p_data->>'lowThreshold')::integer,
          per_order=(p_data->>'perOrder')::integer,revision=revision+1 where id=item_id and revision=(p_data->>'revision')::integer;
        if not found then raise exception using errcode='P0001',message='Malzeme değişti. Güncel kaydı açın.',detail='409'; end if;
      end if;
    when 'packaging-move' then
      select * into material from squishy_shop.packaging_materials where id=item_id for update;
      if not found then raise exception using errcode='P0001',message='Malzeme bulunamadı.',detail='404'; end if;
      if quantity_value is null or quantity_value<1 then raise exception using errcode='P0001',message='Geçerli adet girin.',detail='400'; end if;
      if p_data->>'direction'='out' then quantity_value := -quantity_value; end if;
      if material.quantity+quantity_value<0 then raise exception using errcode='P0001',message='Yeterli ambalaj stoğu yok.',detail='409'; end if;
      update squishy_shop.packaging_materials set quantity=quantity+quantity_value where id=item_id;
      insert into squishy_shop.packaging_movements(material_id,date,quantity,note,actor_id)
      values(item_id,day,quantity_value,coalesce(p_data->>'note',''),p_actor);
    else
      raise exception using errcode='P0001',message='Geçersiz işlem.',detail='400';
  end case;
  insert into squishy_shop.audit(action,entity_id,actor_id,business_date) values(p_action,item_id,p_actor,day);
  return jsonb_build_object('ok',true,'id',item_id);
end $$;
revoke all on function public.shop_inventory_write(integer,text,jsonb) from public,anon,authenticated;
grant execute on function public.shop_inventory_write(integer,text,jsonb) to service_role;

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

  case p_action
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
        insert into squishy_shop.purchases (name,date,total,actor_id)
        values (p_data->>'name',day,(p_data->>'total')::integer,p_actor)
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
          values (order_line.product_id,order_line.product_name,(now() at time zone 'Europe/Istanbul')::date,
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
          select s.* from segments s where s.quantity>0 order by s.priority,s.date,s.id,s.position
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
          raise exception using errcode='P0001', message=format('%s için yeterli stok yok.',product_row.name), detail='409';
        end if;
      end loop;

      if net_after_shipping_amount > order_gross then
        raise exception using errcode='P0001', message='Net tutar satış toplamını aşamaz.', detail='400';
      end if;
      update squishy_shop.orders
      set gross=order_gross,discount=order_discount,cost=order_cost,net_after_shipping=net_after_shipping_amount
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

create or replace function public.shop_stock_write(p_actor integer, p_action text, p_data jsonb)
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
    if (exists (select 1 from squishy_shop.order_lines where lot_id=lot.id) or exists(select 1 from squishy_shop.stock_loss_lines where lot_id=lot.id)) then
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
      insert into squishy_shop.lots (purchase_id,product_id,product_name,quantity,remaining,unit_cost,first_partner_share)
      values (item_id,product_row.id,product_row.name,new_quantity,new_quantity,new_cost,coalesce((line->>'firstPartnerShare')::smallint,product_row.first_partner_share));
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
        and (exists (select 1 from squishy_shop.order_lines where lot_id=lot.id) or exists(select 1 from squishy_shop.stock_loss_lines where lot_id=lot.id)) then
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
          quantity=new_quantity,remaining=new_quantity-used_quantity,unit_cost=new_cost,
          first_partner_share=case when line ? 'firstPartnerShare' then (line->>'firstPartnerShare')::smallint else lot.first_partner_share end
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

create or replace function public.shop_cash_write(p_actor integer, p_action text, p_data jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  item_id integer := (p_data->>'id')::integer;
  movement_kind text := p_data->>'kind';
  movement squishy_shop.cash%rowtype;
  day date := (p_data->>'date')::date;
  account_id integer := (p_data->>'memberId')::integer;
  amount_in_cents integer := (p_data->>'amount')::integer;
  audit_action text;
begin
  if p_action is null or p_action not in ('cash-edit','cash-delete') then
    raise exception using errcode='P0001', message='Geçersiz işlem.', detail='400';
  end if;
  if not exists (select 1 from squishy_shop.members where id=p_actor) then
    raise exception using errcode='P0001', message='Kullanıcı bulunamadı.', detail='404';
  end if;

  if p_action='cash-edit' and movement_kind='purchase'
    and (select count(*) from squishy_shop.purchase_payment_shares where purchase_id=item_id and amount>0)>1 then
    raise exception using errcode='P0001',message='Ortak ödeme tutarlarını alım ödemesinden birlikte düzenleyin.',detail='409';
  end if;
  select * into movement from squishy_shop.cash
  where kind=movement_kind and entity_id=item_id for update;
  if not found then
    raise exception using errcode='P0001', message='Kasa kaydı bulunamadı.', detail='404';
  end if;

  audit_action := case when movement.kind='purchase' then 'purchase-payment' else movement.kind end;
  if p_action='cash-delete' then
    delete from squishy_shop.cash where kind=movement.kind and entity_id=item_id;
    if movement.kind='expense' then
      delete from squishy_shop.expenses where id=item_id;
    end if;
    day := movement.date;
    audit_action := audit_action || '-delete';
  else
    if not exists (select 1 from squishy_shop.members where id=account_id) then
      raise exception using errcode='P0001', message='Hesap bulunamadı.', detail='404';
    end if;
    if movement.kind in ('receipt','expense') and (amount_in_cents is null or amount_in_cents <= 0) then
      raise exception using errcode='P0001', message='Geçerli bir tutar girin.', detail='400';
    end if;

    if movement.kind='expense' then
      update squishy_shop.expenses
      set category=p_data->>'category', amount=amount_in_cents, date=day,
          payer_id=account_id, note=coalesce(p_data->>'note',''),
          first_partner_share=case when p_data ? 'firstPartnerShare' then (p_data->>'firstPartnerShare')::smallint else first_partner_share end
      where id=item_id;
      if not found then
        raise exception using errcode='P0001', message='Gider kaydı bulunamadı.', detail='404';
      end if;
      movement.amount := -amount_in_cents;
      movement.description := p_data->>'category';
    elsif movement.kind='receipt' then
      movement.amount := amount_in_cents;
    end if;

    update squishy_shop.cash
    set amount=movement.amount, date=day, member_id=account_id, description=movement.description
    where kind=movement.kind and entity_id=item_id;
    audit_action := audit_action || '-edit';
  end if;

  insert into squishy_shop.audit (action,entity_id,actor_id,business_date)
  values (audit_action,item_id,p_actor,day);
  return jsonb_build_object('ok',true,'id',item_id);
end $$;

notify pgrst, 'reload schema';

commit;

begin;

-- The two accounts are fixed at setup. The stored percentage belongs to the lower member ID.
alter table squishy_shop.products add column first_partner_share smallint check (first_partner_share between 0 and 100);
alter table squishy_shop.order_lines add column first_partner_share smallint check (first_partner_share between 0 and 100);
alter table squishy_shop.expenses add column first_partner_share smallint check (first_partner_share between 0 and 100);

create table squishy_shop.partner_transfers (
  id integer generated always as identity primary key,
  sender_id integer not null references squishy_shop.members,
  recipient_id integer not null references squishy_shop.members,
  amount integer not null check (amount > 0),
  date date not null,
  note text not null,
  actor_id integer not null references squishy_shop.members,
  check (sender_id <> recipient_id)
);
alter table squishy_shop.partner_transfers enable row level security;
revoke all on squishy_shop.partner_transfers from public, anon, authenticated;
revoke all on sequence squishy_shop.partner_transfers_id_seq from public, anon, authenticated;
grant select, insert, delete on squishy_shop.partner_transfers to service_role;
grant usage on sequence squishy_shop.partner_transfers_id_seq to service_role;

create function public.shop_partnership_write(p_actor integer, p_action text, p_data jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  item_id integer := (p_data->>'id')::integer;
  product_id_to_update integer := (p_data->>'productId')::integer;
  sender integer := (p_data->>'senderId')::integer;
  recipient integer := (p_data->>'recipientId')::integer;
  share smallint := (p_data->>'firstPartnerShare')::smallint;
  day date := (p_data->>'date')::date;
begin
  if not exists (select 1 from squishy_shop.members where id=p_actor) then
    raise exception using errcode='P0001', message='Kullanıcı bulunamadı.', detail='404';
  end if;
  case p_action
    when 'order-share' then
      select o.date into day from squishy_shop.orders o where o.id=item_id for update;
      if not found then
        raise exception using errcode='P0001', message='Sipariş bulunamadı.', detail='404';
      end if;
      if share is null or share not between 0 and 100 then
        raise exception using errcode='P0001', message='Geçerli bir pay oranı girin.', detail='400';
      end if;
      update squishy_shop.order_lines
      set first_partner_share=share
      where order_id=item_id and product_id=product_id_to_update and first_partner_share is null;
      if not found then
        raise exception using errcode='P0001', message='Eksik ürün payı bulunamadı veya pay daha önce kaydedildi.', detail='409';
      end if;
    when 'partner-transfer' then
      if sender is not distinct from recipient or (
        select count(*) from squishy_shop.members where id in (sender,recipient)
      ) <> 2 then
        raise exception using errcode='P0001', message='Transfer için iki farklı ortak seçin.', detail='400';
      end if;
      insert into squishy_shop.partner_transfers (sender_id,recipient_id,amount,date,note,actor_id)
      values (sender,recipient,(p_data->>'amount')::integer,day,coalesce(p_data->>'note',''),p_actor)
      returning id into item_id;
    when 'partner-transfer-delete' then
      delete from squishy_shop.partner_transfers where id=item_id returning date into day;
      if not found then
        raise exception using errcode='P0001', message='Transfer bulunamadı.', detail='404';
      end if;
    else
      raise exception using errcode='P0001', message='Geçersiz işlem.', detail='400';
  end case;
  insert into squishy_shop.audit (action,entity_id,actor_id,business_date)
  values (p_action,item_id,p_actor,day);
  return jsonb_build_object('ok',true,'id',item_id);
end $$;

revoke all on function public.shop_partnership_write(integer,text,jsonb) from public, anon, authenticated;
grant execute on function public.shop_partnership_write(integer,text,jsonb) to service_role;

create or replace function public.shop_write(p_actor integer, p_action text, p_data jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  item_id integer := (p_data->>'id')::integer;
  day date := (p_data->>'date')::date;
  member_id integer := (p_data->>'payerId')::integer;
  order_row squishy_shop.orders%rowtype;
  order_line squishy_shop.order_lines%rowtype;
  purchase_row squishy_shop.purchases%rowtype;
  product_row squishy_shop.products%rowtype;
  lot squishy_shop.lots%rowtype;
  line jsonb;
  quantity integer;
  remaining integer;
  used_quantity integer;
  unit_amount integer;
  platform_list_price integer;
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

  -- Serialize inventory writers by product, using a consistent lock order.
  if p_action in ('purchase','order') then
    perform p.id from squishy_shop.products p
    where p.id in (select (value->>'productId')::integer from jsonb_array_elements(p_data->'lines'))
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
          insert into squishy_shop.lots (purchase_id,product_id,product_name,quantity,remaining,unit_cost)
          values (item_id,product_row.id,product_row.name,quantity,quantity,unit_amount);
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

      if member_id is not null then
        if not exists (select 1 from squishy_shop.members where id=member_id) then
          raise exception using errcode='P0001', message='Ödeyen kullanıcı bulunamadı.', detail='404';
        end if;
        insert into squishy_shop.cash (kind,entity_id,date,amount,member_id,actor_id,description)
        values ('purchase',item_id,day,-purchase_row.total,member_id,p_actor,purchase_row.name)
        on conflict (kind,entity_id) do nothing;
        if not found then
          raise exception using errcode='P0001', message='Bu alışın ödemesi zaten kaydedildi.', detail='409';
        end if;
      end if;

    when 'order' then
      insert into squishy_shop.orders (platform,reference,date,platform_fee,shipping,packing,actor_id)
      values (p_data->>'platform',p_data->>'reference',day,
        (p_data->>'platformFee')::integer,(p_data->>'shipping')::integer,(p_data->>'packing')::integer,p_actor)
      returning * into order_row;
      item_id := order_row.id;

      for line in select value from jsonb_array_elements(p_data->'lines')
      loop
        select * into product_row from squishy_shop.products where id=(line->>'productId')::integer;
        if not found then
          raise exception using errcode='P0001', message='Ürün bulunamadı.', detail='404';
        end if;
        quantity := (line->>'quantity')::integer;
        unit_amount := (line->>'agreedPrice')::integer;
        platform_list_price := case order_row.platform
          when 'Dolap' then product_row.dolap_list_price
          when 'Gardrops' then product_row.gardrops_list_price
        end;
        remaining := quantity;
        order_gross := order_gross + quantity::bigint * unit_amount;
        order_discount := order_discount + quantity::bigint * greatest(0, platform_list_price::bigint - unit_amount);

        for lot in
          select l.* from squishy_shop.lots l
          join squishy_shop.purchases p on p.id=l.purchase_id
          where l.product_id=product_row.id and l.remaining>0
          order by p.date,l.id
        loop
          used_quantity := least(remaining,lot.remaining);
          update squishy_shop.lots set remaining=lot.remaining-used_quantity where id=lot.id;
          insert into squishy_shop.order_lines (order_id,product_id,product_name,lot_id,quantity,list_price,agreed_price,unit_cost,first_partner_share)
          values (item_id,product_row.id,product_row.name,lot.id,used_quantity,platform_list_price,unit_amount,lot.unit_cost,product_row.first_partner_share);
          insert into squishy_shop.stock (product_id,product_name,date,kind,quantity,unit_cost,actor_id,reference)
          values (product_row.id,product_row.name,day,'sale',-used_quantity,lot.unit_cost,p_actor,order_row.reference);
          order_cost := order_cost + used_quantity::bigint * lot.unit_cost;
          remaining := remaining - used_quantity;
          exit when remaining=0;
        end loop;

        if remaining>0 then
          raise exception using errcode='P0001', message=format('%s için yeterli stok yok.',product_row.name), detail='409';
        end if;
      end loop;

      update squishy_shop.orders set gross=order_gross,discount=order_discount,cost=order_cost where id=item_id;

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
  if p_action='purchase' and member_id is not null then
    insert into squishy_shop.audit (action,entity_id,actor_id,business_date) values ('purchase-payment',item_id,p_actor,day);
  end if;
  return jsonb_build_object('ok',true,'id',item_id);
end $$;

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

begin;

create schema squishy_shop;
revoke all on schema squishy_shop from public, anon, authenticated;
grant usage on schema squishy_shop to service_role;

create table squishy_shop.members (
  id integer generated always as identity primary key,
  username text not null unique,
  name text not null,
  salt text not null,
  password_hash text not null
);
create table squishy_shop.sessions (
  token_hash text primary key,
  member_id integer not null references squishy_shop.members,
  expires_at timestamptz not null
);
create index on squishy_shop.sessions (expires_at);
create index on squishy_shop.sessions (member_id);
create table squishy_shop.rate_limits (
  key text primary key,
  bucket bigint not null,
  attempts integer not null,
  updated_at timestamptz not null default now()
);
create table squishy_shop.products (
  id integer generated always as identity primary key,
  name text not null,
  photo text,
  photo_version integer not null default 1,
  list_price integer not null check (list_price >= 0),
  low_threshold integer not null check (low_threshold >= 0)
);
create table squishy_shop.purchases (
  id integer generated always as identity primary key,
  name text not null,
  date date not null,
  total integer not null check (total > 0),
  actor_id integer not null references squishy_shop.members
);
create table squishy_shop.lots (
  id integer generated always as identity primary key,
  purchase_id integer not null references squishy_shop.purchases,
  product_id integer not null references squishy_shop.products,
  product_name text not null,
  quantity integer not null check (quantity > 0),
  remaining integer not null check (remaining between 0 and quantity),
  unit_cost integer not null check (unit_cost >= 0)
);
create index on squishy_shop.lots (product_id, id) where remaining > 0;
create index on squishy_shop.lots (purchase_id, id);
create table squishy_shop.orders (
  id integer generated always as identity primary key,
  platform text not null check (platform in ('Dolap', 'Gardrops')),
  reference text not null,
  date date not null,
  status text not null default 'pending' check (status in ('pending', 'packed', 'cancelled', 'returned')),
  gross bigint not null default 0,
  discount bigint not null default 0,
  platform_fee integer not null check (platform_fee >= 0),
  shipping integer not null check (shipping >= 0),
  packing integer not null check (packing >= 0),
  cost bigint not null default 0,
  return_sellable boolean,
  actor_id integer not null references squishy_shop.members
);
create table squishy_shop.order_lines (
  id integer generated always as identity primary key,
  order_id integer not null references squishy_shop.orders,
  product_id integer not null references squishy_shop.products,
  product_name text not null,
  lot_id integer not null references squishy_shop.lots,
  quantity integer not null check (quantity > 0),
  list_price integer not null,
  agreed_price integer not null check (agreed_price >= 0),
  unit_cost integer not null,
  returned_quantity integer not null default 0 check (returned_quantity between 0 and quantity)
);
create index on squishy_shop.order_lines (order_id, id);
create table squishy_shop.expenses (
  id integer generated always as identity primary key,
  category text not null,
  amount integer not null check (amount > 0),
  date date not null,
  payer_id integer not null references squishy_shop.members,
  actor_id integer not null references squishy_shop.members,
  note text not null
);
create table squishy_shop.cash (
  kind text not null check (kind in ('purchase','receipt','expense')),
  entity_id integer not null,
  date date not null,
  amount integer not null check (amount <> 0),
  member_id integer not null references squishy_shop.members,
  actor_id integer not null references squishy_shop.members,
  description text not null,
  primary key (kind, entity_id)
);
create table squishy_shop.stock (
  id integer generated always as identity primary key,
  product_id integer not null references squishy_shop.products,
  product_name text not null,
  date date not null,
  kind text not null check (kind in ('purchase','sale','cancelled','returned')),
  quantity integer not null check (quantity <> 0),
  unit_cost integer not null,
  actor_id integer not null references squishy_shop.members,
  reference text not null
);
create table squishy_shop.audit (
  id integer generated always as identity primary key,
  action text not null,
  entity_id integer not null,
  actor_id integer not null references squishy_shop.members,
  business_date date,
  status text,
  created_at timestamptz not null default now()
);

do $$
declare
  table_name text;
begin
  for table_name in select tablename from pg_catalog.pg_tables where schemaname = 'squishy_shop'
  loop
    execute format('alter table squishy_shop.%I enable row level security', table_name);
  end loop;
end $$;

revoke all on all tables in schema squishy_shop from public, anon, authenticated;
revoke all on all sequences in schema squishy_shop from public, anon, authenticated;
grant select, insert, update, delete on all tables in schema squishy_shop to service_role;
grant usage on all sequences in schema squishy_shop to service_role;

create function public.shop_auth(p_action text, p_data jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  member squishy_shop.members%rowtype;
  input_user jsonb;
  bucket_number bigint;
  attempt_count integer;
begin
  case p_action
    when 'session' then
      select m.* into member
      from squishy_shop.sessions s join squishy_shop.members m on m.id = s.member_id
      where s.token_hash = p_data->>'tokenHash' and s.expires_at > now();
      return jsonb_build_object(
        'user', case when member.id is not null then jsonb_build_object('id',member.id,'username',member.username,'name',member.name) end,
        'needsSetup', not exists (select 1 from squishy_shop.members)
      );
    when 'limit' then
      bucket_number := (p_data->>'window')::bigint;
      insert into squishy_shop.rate_limits as limits (key,bucket,attempts)
      values (p_data->>'key',bucket_number,1)
      on conflict (key) do update set
        bucket = greatest(excluded.bucket,limits.bucket),
        attempts = case when excluded.bucket > limits.bucket then 1 else limits.attempts + 1 end,
        updated_at = now()
      returning attempts into attempt_count;
      return jsonb_build_object('allowed', attempt_count <= (p_data->>'maximum')::integer);
    when 'clear-limit' then
      delete from squishy_shop.rate_limits where key = p_data->>'key';
      return '{}'::jsonb;
    when 'setup' then
      lock table squishy_shop.members in share row exclusive mode;
      if exists (select 1 from squishy_shop.members) then
        raise exception using errcode='P0001', message='Kurulum zaten tamamlandı.', detail='409';
      end if;
      if jsonb_array_length(p_data->'users') <> 2 then
        raise exception using errcode='P0001', message='Kurulum için iki kullanıcı gerekli.', detail='400';
      end if;
      for input_user in select value from jsonb_array_elements(p_data->'users')
      loop
        insert into squishy_shop.members (username,name,salt,password_hash)
        values (input_user->>'username',input_user->>'name',input_user->>'salt',input_user->>'passwordHash')
        returning * into member;
      end loop;
      select * into member from squishy_shop.members order by id limit 1;
      insert into squishy_shop.sessions (token_hash, member_id, expires_at)
      values (p_data->>'tokenHash', member.id, to_timestamp((p_data->>'expiresAt')::double precision));
    when 'credentials' then
      select * into member from squishy_shop.members where username = p_data->>'username';
      if member.id is null then return null; end if;
      return jsonb_build_object('id',member.id,'username',member.username,'name',member.name,'salt',member.salt,'passwordHash',member.password_hash);
    when 'login' then
      select * into member from squishy_shop.members where id = (p_data->>'id')::integer;
      if member.id is null then
        raise exception using errcode='P0001', message='Kullanıcı bulunamadı.', detail='404';
      end if;
      delete from squishy_shop.sessions where expires_at <= now();
      insert into squishy_shop.sessions (token_hash, member_id, expires_at)
      values (p_data->>'tokenHash', member.id, to_timestamp((p_data->>'expiresAt')::double precision));
    when 'logout' then
      delete from squishy_shop.sessions where token_hash = p_data->>'tokenHash';
      return '{}'::jsonb;
    else
      raise exception using errcode='P0001', message='Geçersiz işlem.', detail='400';
  end case;
  return jsonb_build_object('id',member.id,'username',member.username,'name',member.name);
end $$;

create function public.shop_write(p_actor integer, p_action text, p_data jsonb)
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
        insert into squishy_shop.products (name,photo,list_price,low_threshold)
        values (p_data->>'name',p_data->>'photo',(p_data->>'listPrice')::integer,(p_data->>'lowThreshold')::integer)
        returning id into item_id;
      else
        update squishy_shop.products p
        set name=p_data->>'name',
            photo=case when p_data ? 'photo' then p_data->>'photo' else p.photo end,
            photo_version=p.photo_version + case when p_data ? 'photo' and (p_data->>'photo') is distinct from p.photo then 1 else 0 end,
            list_price=(p_data->>'listPrice')::integer,
            low_threshold=(p_data->>'lowThreshold')::integer
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
        remaining := quantity;
        order_gross := order_gross + quantity::bigint * unit_amount;
        order_discount := order_discount + quantity::bigint * greatest(0, product_row.list_price::bigint - unit_amount);

        for lot in
          select l.* from squishy_shop.lots l
          join squishy_shop.purchases p on p.id=l.purchase_id
          where l.product_id=product_row.id and l.remaining>0
          order by p.date,l.id
        loop
          used_quantity := least(remaining,lot.remaining);
          update squishy_shop.lots set remaining=lot.remaining-used_quantity where id=lot.id;
          insert into squishy_shop.order_lines (order_id,product_id,product_name,lot_id,quantity,list_price,agreed_price,unit_cost)
          values (item_id,product_row.id,product_row.name,lot.id,used_quantity,product_row.list_price,unit_amount,lot.unit_cost);
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
      insert into squishy_shop.expenses (category,amount,date,payer_id,actor_id,note)
      values (p_data->>'category',unit_amount,day,member_id,p_actor,coalesce(p_data->>'note',''))
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

create function public.shop_read(p_action text, p_data jsonb)
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
        'id',p.id,'name',p.name,'listPrice',p.list_price,'lowThreshold',p.low_threshold,
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
            'listPrice',l.list_price,'agreedPrice',l.agreed_price,'unitCost',l.unit_cost,'cost',l.quantity::bigint*l.unit_cost
          ) order by l.id)
          from squishy_shop.order_lines l where l.order_id=o.id
        ),'[]'::jsonb)
      ) order by o.date desc,o.id desc)
      from squishy_shop.orders o left join squishy_shop.cash c on c.kind='receipt' and c.entity_id=o.id
    ),'[]'::jsonb),
    'expenses', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',e.id,'category',e.category,'amount',e.amount,'date',e.date,'payerId',e.payer_id,'actorId',e.actor_id,'note',e.note
      ) order by e.date desc,e.id desc)
      from squishy_shop.expenses e
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

revoke all on function public.shop_auth(text,jsonb) from public, anon, authenticated;
revoke all on function public.shop_write(integer,text,jsonb) from public, anon, authenticated;
revoke all on function public.shop_read(text,jsonb) from public, anon, authenticated;
grant execute on function public.shop_auth(text,jsonb) to service_role;
grant execute on function public.shop_write(integer,text,jsonb) to service_role;
grant execute on function public.shop_read(text,jsonb) to service_role;
notify pgrst, 'reload schema';

commit;


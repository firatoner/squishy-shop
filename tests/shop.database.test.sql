-- Run as the migration owner on an empty Squishy Shop test database.
-- All fixture rows roll back. PostgreSQL identity sequence values may advance.
begin;
set local plpgsql.check_asserts = on;

do $fixture$
declare
  actor integer;
  partner integer;
  product integer;
  purchase integer;
  first_order integer;
  second_order integer;
  receipt_order integer;
  error_status text;
  result jsonb;
  order_payload jsonb;
  stock_payload jsonb;
  payment_payload jsonb;
begin
  assert (public.shop_auth('session', '{}')->>'needsSetup')::boolean;
  assert not has_function_privilege('anon', 'public.shop_write(integer,text,jsonb)', 'execute');
  assert not has_function_privilege('authenticated', 'public.shop_read(text,jsonb)', 'execute');
  assert not has_function_privilege('anon', 'public.shop_inventory_write(integer,text,jsonb)', 'execute');
  assert not has_function_privilege('anon', 'public.shop_order_delete(integer,text,jsonb)', 'execute');

  actor := (public.shop_auth('setup', '{
    "users": [
      {"username":"qa_first","name":"QA First","salt":"fixture","passwordHash":"fixture"},
      {"username":"qa_second","name":"QA Second","salt":"fixture","passwordHash":"fixture"}
    ],
    "tokenHash":"fixture-first",
    "expiresAt":4102444800
  }')->>'id')::integer;
  partner := (public.shop_auth('credentials', '{"username":"qa_second"}')->>'id')::integer;
  assert actor <> partner;
  perform public.shop_auth('login', jsonb_build_object('id',partner,'tokenHash','fixture-second','expiresAt',4102444800));
  assert (public.shop_auth('session','{"tokenHash":"fixture-first"}')->'user'->>'id')::integer = actor;
  assert (public.shop_auth('session','{"tokenHash":"fixture-second"}')->'user'->>'id')::integer = partner;

  product := (public.shop_write(actor,'product','{"name":"Peach","dolapListPrice":60000,"gardropsListPrice":64000,"lowThreshold":1}')->>'id')::integer;
  result := public.shop_read('state','{}')->'products'->0;
  assert (result->>'dolapListPrice')::integer = 60000;
  assert (result->>'gardropsListPrice')::integer = 64000;
  purchase := (public.shop_write(actor,'purchase',jsonb_build_object(
    'date','2026-09-15','total',20000,'name','QA wholesale',
    'lines',jsonb_build_array(jsonb_build_object('productId',product,'quantity',1,'unitCost',20000))
  ))->>'id')::integer;
  assert jsonb_array_length(public.shop_read('state','{}')->'cash') = 0;

  order_payload := jsonb_build_object(
    'date','2026-09-15','platform','Dolap','reference','QA-1','platformFee',4000,'shipping',0,'packing',1000,
    'lines',jsonb_build_array(jsonb_build_object('productId',product,'quantity',1,'agreedPrice',55000))
  );
  first_order := (public.shop_write(actor,'order',order_payload)->>'id')::integer;
  assert (public.shop_read('state','{}')->'products'->0->>'stock')::integer = 0;
  begin
    perform public.shop_write(partner,'order',order_payload || '{"reference":"QA-conflict"}');
    raise exception 'A second order reserved the same inventory';
  exception when sqlstate 'P0001' then
    get stacked diagnostics error_status = pg_exception_detail;
    assert error_status = '409';
  end;
  assert jsonb_array_length(public.shop_read('state','{}')->'orders') = 1;

  perform public.shop_write(actor,'product',jsonb_build_object(
    'id',product,'name','Peach','dolapListPrice',65000,'gardropsListPrice',70000,'lowThreshold',1
  ));
  result := public.shop_read('state','{}')->'orders'->0;
  assert (result->'lines'->0->>'listPrice')::integer = 60000;
  assert (result->>'discount')::integer = 5000;
  assert (result->>'expectedReceipt')::integer = 51000;
  assert (result->>'profit')::integer = 30000;

  stock_payload := jsonb_build_object('id',first_order,'status','cancelled','date','2026-09-16');
  perform public.shop_write(partner,'order-status',stock_payload);
  begin
    perform public.shop_write(partner,'order-status',stock_payload);
    raise exception 'Cancelled order restored inventory twice';
  exception when sqlstate 'P0001' then
    get stacked diagnostics error_status = pg_exception_detail;
    assert error_status = '409';
  end;
  assert (public.shop_read('state','{}')->'products'->0->>'stock')::integer = 1;

  second_order := (public.shop_write(actor,'order',order_payload || '{"platform":"Gardrops","reference":"QA-2"}')->>'id')::integer;
  select value into result from jsonb_array_elements(public.shop_read('state','{}')->'orders') where (value->>'id')::integer = second_order;
  assert (result->'lines'->0->>'listPrice')::integer = 70000;
  assert (result->>'discount')::integer = 15000;
  stock_payload := jsonb_build_object('id',second_order,'date','2026-09-16');
  perform public.shop_write(actor,'order-status',stock_payload || '{"status":"packed"}');
  perform public.shop_write(partner,'order-status',stock_payload || '{"status":"returned","sellable":true}');
  begin
    perform public.shop_write(partner,'order-status',stock_payload || '{"status":"returned","sellable":true}');
    raise exception 'Returned order restored inventory twice';
  exception when sqlstate 'P0001' then
    get stacked diagnostics error_status = pg_exception_detail;
    assert error_status = '409';
  end;
  assert (public.shop_read('state','{}')->'products'->0->>'stock')::integer = 1;

  receipt_order := (public.shop_write(actor,'order',order_payload || '{"reference":"QA-receipt"}')->>'id')::integer;
  stock_payload := jsonb_build_object('id',receipt_order,'date','2026-09-16');
  perform public.shop_write(actor,'order-status',stock_payload || '{"status":"packed"}');
  assert jsonb_array_length(public.shop_read('state','{}')->'cash') = 0;
  perform public.shop_write(partner,'receipt',stock_payload || jsonb_build_object('amount',51000,'recipientId',actor));

  payment_payload := jsonb_build_object('id',purchase,'date','2026-09-16','payerId',actor);
  perform public.shop_write(partner,'purchase-payment',payment_payload);
  begin
    perform public.shop_write(partner,'purchase-payment',payment_payload);
    raise exception 'Supplier invoice was paid twice';
  exception when sqlstate 'P0001' then
    get stacked diagnostics error_status = pg_exception_detail;
    assert error_status = '409';
  end;
  perform public.shop_write(actor,'expense',jsonb_build_object(
    'date','2026-09-16','payerId',partner,'amount',260,'category','Supplies','note','Tape'
  ));

  result := public.shop_read('state','{}');
  assert jsonb_array_length(result->'cash') = 3;
  assert (result->'summary'->>'cashBalance')::integer = 30740;
  assert result->'cash' @> jsonb_build_array(jsonb_build_object(
    'kind','receipt','amount',51000,'memberId',actor,'actorId',partner
  ));
  assert result->'cash' @> jsonb_build_array(jsonb_build_object(
    'kind','purchase','amount',-20000,'memberId',actor,'actorId',partner
  ));
  assert result->'cash' @> jsonb_build_array(jsonb_build_object(
    'kind','expense','amount',-260,'memberId',partner,'actorId',actor
  ));

  perform public.shop_auth('logout','{"tokenHash":"fixture-first"}');
  assert public.shop_auth('session','{"tokenHash":"fixture-first"}')->'user' = 'null'::jsonb;
  assert (public.shop_auth('session','{"tokenHash":"fixture-second"}')->'user'->>'id')::integer = partner;
end;
$fixture$;

rollback;
select 'Squishy Shop database fixture passed; fixture rows rolled back.' as result;

begin;

create function public.shop_cash_write(p_actor integer, p_action text, p_data jsonb)
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
          payer_id=account_id, note=coalesce(p_data->>'note','')
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

revoke all on function public.shop_cash_write(integer,text,jsonb) from public, anon, authenticated;
grant execute on function public.shop_cash_write(integer,text,jsonb) to service_role;
notify pgrst, 'reload schema';

commit;

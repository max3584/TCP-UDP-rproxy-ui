// global の geoip・acme の欄（/global の「API で変える」。rproxy-api v0.4.22、#345。UI #189）。
// 値と送る形の行き来・確かめは components/globalacme.ts。秘密の値の欄は作らない：秘密はファイル（RPROXY_API_ACME_DIR のすぐ下）を指すだけ
import { ACME_DEFAULT_STORAGE, CHALLENGES, DNS_PROVIDER_TYPES, MASKED, TSIG_ALGORITHMS, emptyAccount, emptyProvider, emptyResolver } from './globalacme';
import type { AcmeAccountForm, AcmeForm, AcmeProviderForm, AcmeResolverForm, GeoipForm, HttpCallForm } from './globalacme';

const INPUT = 'w-full border border-gray-300 rounded-sm px-2 py-1 bg-white text-gray-900 font-mono text-sm';
const GRID = 'grid grid-cols-1 sm:grid-cols-[12rem_1fr] gap-x-3 gap-y-1 items-center';

const Field: React.FC<{ id: string; label: string; value: string; onChange: (v: string) => void; placeholder?: string; rows?: number }> = (
  { id, label, value, onChange, placeholder, rows },
) => (
  <label className="contents">
    <span className="font-mono text-xs text-gray-700">{label}</span>
    {rows
      ? <textarea id={id} className={INPUT} rows={rows} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      : <input id={id} className={INPUT} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />}
  </label>
);

const Choice: React.FC<{ id: string; label: string; value: string; options: readonly string[]; onChange: (v: string) => void; empty?: string }> = (
  { id, label, value, options, onChange, empty },
) => (
  <label className="contents">
    <span className="font-mono text-xs text-gray-700">{label}</span>
    <select id={id} className={INPUT} value={value} onChange={(e) => onChange(e.target.value)}>
      {empty !== undefined && <option value="">{empty}</option>}
      {!options.includes(value) && value !== '' && <option value={value}>{value}</option>}
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  </label>
);

export const GeoipFields: React.FC<{ form: GeoipForm; onChange: (f: GeoipForm) => void }> = ({ form, onChange }) => (
  <div className="space-y-2">
    <p className="text-xs text-gray-700">データベースのファイルは rproxy-api の RPROXY_API_GEOIP_DIR のすぐ下の通常のファイル（geoipupdate の DatabaseDirectory）を絶対パスで書きます（ほかの場所は rproxy が断ります）。</p>
    <div className={GRID}>
      <Field id="global-geoip-country_db" label="country_db" value={form.country_db} placeholder="/var/lib/GeoIP/GeoLite2-Country.mmdb" onChange={(v) => onChange({ ...form, country_db: v })} />
      <Field id="global-geoip-asn_db" label="asn_db" value={form.asn_db} placeholder="/var/lib/GeoIP/GeoLite2-ASN.mmdb" onChange={(v) => onChange({ ...form, asn_db: v })} />
      <Field id="global-geoip-check_interval" label="check_interval" value={form.check_interval} placeholder="既定 1m" onChange={(v) => onChange({ ...form, check_interval: v })} />
      <span className="font-mono text-xs text-gray-700">log_country</span>
      <label className="inline-flex items-center gap-1 text-sm text-gray-900">
        <input id="global-geoip-log_country" type="checkbox" checked={form.log_country} onChange={(e) => onChange({ ...form, log_country: e.target.checked })} />
        ログに国（と ASN）を足す
      </label>
    </div>
  </div>
);

const SECRET_FILE_NOTE = '秘密そのものは書けません。中身を置いたファイル（RPROXY_API_ACME_DIR のすぐ下）の絶対パスを書きます。';

const CallFields: React.FC<{ id: string; label: string; call: HttpCallForm; onChange: (c: HttpCallForm) => void }> = ({ id, label, call, onChange }) => (
  <fieldset className="border border-gray-200 rounded-sm p-2 space-y-1">
    <legend className="px-1 font-mono text-xs text-gray-800">{label}</legend>
    <div className={GRID}>
      <Field id={`${id}-method`} label="method" value={call.method} placeholder="POST" onChange={(v) => onChange({ ...call, method: v })} />
      <Field id={`${id}-url`} label="url" value={call.url} placeholder="https://dns-relay.example.net/present" onChange={(v) => onChange({ ...call, url: v })} />
      <Field id={`${id}-headers`} label="headers" rows={2} value={call.headers} placeholder="Authorization: Bearer {secret}" onChange={(v) => onChange({ ...call, headers: v })} />
      <Field id={`${id}-body`} label="body" rows={2} value={call.body} placeholder={'{"fqdn":"{fqdn}","value":"{value}"}'} onChange={(v) => onChange({ ...call, body: v })} />
    </div>
  </fieldset>
);

function update<T>(list: T[], i: number, v: T): T[] {
  return list.map((x, j) => (j === i ? v : x));
}

const AccountRow: React.FC<{ i: number; a: AcmeAccountForm; onChange: (a: AcmeAccountForm) => void; onRemove: () => void }> = ({ i, a, onChange, onRemove }) => {
  const id = `global-acme-account-${i}`;
  return (
    <fieldset className="border border-gray-200 rounded-sm p-2 space-y-1" data-testid="global-acme-account">
      <legend className="px-1 text-xs text-gray-800">アカウント</legend>
      <div className={GRID}>
        <Field id={`${id}-name`} label="名前" value={a.name} placeholder="letsencrypt" onChange={(v) => onChange({ ...a, name: v })} />
        <Field id={`${id}-directory`} label="directory" value={a.directory} placeholder="https://acme-v02.api.letsencrypt.org/directory" onChange={(v) => onChange({ ...a, directory: v })} />
        <Field id={`${id}-contact`} label="contact" value={a.contact} placeholder="mailto:admin@example.com" onChange={(v) => onChange({ ...a, contact: v })} />
        <Field id={`${id}-allowed_names`} label="allowed_names" rows={2} value={a.allowed_names} placeholder="example.com, *.example.com" onChange={(v) => onChange({ ...a, allowed_names: v })} />
        <Field id={`${id}-ca_file`} label="ca_file" value={a.ca_file} onChange={(v) => onChange({ ...a, ca_file: v })} />
        <Field id={`${id}-eab_kid`} label="eab.kid" value={a.eab_kid} onChange={(v) => onChange({ ...a, eab_kid: v })} />
        <Field id={`${id}-eab_hmac_key_file`} label="eab.hmac_key_file" value={a.eab_hmac_key_file} onChange={(v) => onChange({ ...a, eab_hmac_key_file: v })} />
      </div>
      <p className="text-xs text-gray-700">アカウントの鍵（key_file）は書けません。rproxy が storage に作ります。</p>
      <button type="button" className="btn-secondary" onClick={onRemove}>このアカウントを外す</button>
    </fieldset>
  );
};

const ProviderRow: React.FC<{ i: number; p: AcmeProviderForm; onChange: (p: AcmeProviderForm) => void; onRemove: () => void }> = ({ i, p, onChange, onRemove }) => {
  const id = `global-acme-provider-${i}`;
  const set = (k: keyof AcmeProviderForm) => (v: string) => onChange({ ...p, [k]: v });
  return (
    <fieldset className="border border-gray-200 rounded-sm p-2 space-y-1" data-testid="global-acme-provider">
      <legend className="px-1 text-xs text-gray-800">DNS のプロバイダ</legend>
      <div className={GRID}>
        <Field id={`${id}-name`} label="名前" value={p.name} placeholder="pdns" onChange={set('name')} />
        <Choice id={`${id}-type`} label="type" value={p.type} options={DNS_PROVIDER_TYPES} onChange={set('type')} />
        {(p.type === 'powerdns' || p.type === 'acme_dns') && <Field id={`${id}-api_url`} label="api_url" value={p.api_url} onChange={set('api_url')} />}
        {p.type === 'powerdns' && (
          <>
            <Field id={`${id}-server_id`} label="server_id" value={p.server_id} placeholder="既定 localhost" onChange={set('server_id')} />
            <Field id={`${id}-api_key_file`} label="api_key_file" value={p.api_key_file} onChange={set('api_key_file')} />
          </>
        )}
        {p.type === 'rfc2136' && (
          <>
            <Field id={`${id}-server`} label="server" value={p.server} placeholder="10.0.0.53" onChange={set('server')} />
            <Field id={`${id}-tsig_key_name`} label="tsig_key_name" value={p.tsig_key_name} onChange={set('tsig_key_name')} />
            <Choice id={`${id}-tsig_algorithm`} label="tsig_algorithm" value={p.tsig_algorithm} options={TSIG_ALGORITHMS} empty="既定（hmac-sha256）" onChange={set('tsig_algorithm')} />
            <Field id={`${id}-tsig_secret_file`} label="tsig_secret_file" value={p.tsig_secret_file} onChange={set('tsig_secret_file')} />
          </>
        )}
        {p.type === 'acme_dns' && <Field id={`${id}-credentials_file`} label="credentials_file" value={p.credentials_file} onChange={set('credentials_file')} />}
        {p.type === 'http' && <Field id={`${id}-secret_file`} label="secret_file" value={p.secret_file} onChange={set('secret_file')} />}
        <Field id={`${id}-zones`} label="zones" value={p.zones} placeholder="acme.example.net" onChange={set('zones')} />
        <Field id={`${id}-allowed_names`} label="allowed_names" rows={2} value={p.allowed_names} placeholder="*.example.com" onChange={set('allowed_names')} />
        <Field id={`${id}-ttl`} label="ttl" value={p.ttl} onChange={set('ttl')} />
        <Field id={`${id}-ca_file`} label="ca_file" value={p.ca_file} onChange={set('ca_file')} />
      </div>
      {p.type === 'http' && (
        <>
          <p className="text-xs text-gray-700">
            {'資格情報は secret_file の中身を {secret} で差し込みます。資格情報らしい名前のヘッダは {secret} か「Bearer {secret}」の形だけ、クエリは {secret} だけで、URL のパスと利用者には書けません。'}
          </p>
          <CallFields id={`${id}-add`} label="add" call={p.add} onChange={(c) => onChange({ ...p, add: c })} />
          <CallFields id={`${id}-remove`} label="remove" call={p.remove} onChange={(c) => onChange({ ...p, remove: c })} />
        </>
      )}
      <button type="button" className="btn-secondary" onClick={onRemove}>このプロバイダを外す</button>
    </fieldset>
  );
};

const ResolverRow: React.FC<{ i: number; r: AcmeResolverForm; accounts: string[]; providers: string[]; onChange: (r: AcmeResolverForm) => void; onRemove: () => void }> = (
  { i, r, accounts, providers, onChange, onRemove },
) => {
  const id = `global-acme-resolver-${i}`;
  return (
    <fieldset className="border border-gray-200 rounded-sm p-2 space-y-1" data-testid="global-acme-resolver">
      <legend className="px-1 text-xs text-gray-800">resolver</legend>
      <div className={GRID}>
        <Field id={`${id}-name`} label="名前" value={r.name} placeholder="le-http" onChange={(v) => onChange({ ...r, name: v })} />
        <Choice id={`${id}-account`} label="account" value={r.account} options={accounts} empty="（選ぶ）" onChange={(v) => onChange({ ...r, account: v })} />
        <Choice id={`${id}-challenge`} label="challenge" value={r.challenge} options={CHALLENGES} onChange={(v) => onChange({ ...r, challenge: v, dns_provider: v === 'dns-01' ? r.dns_provider : '' })} />
        {r.challenge === 'dns-01' && (
          <Choice id={`${id}-dns_provider`} label="dns_provider" value={r.dns_provider} options={providers} empty="（選ぶ）" onChange={(v) => onChange({ ...r, dns_provider: v })} />
        )}
      </div>
      <button type="button" className="btn-secondary" onClick={onRemove}>この resolver を外す</button>
    </fieldset>
  );
};

export const AcmeFields: React.FC<{ form: AcmeForm; onChange: (f: AcmeForm) => void; masked: boolean }> = ({ form, onChange, masked }) => {
  const set = (k: keyof AcmeForm) => (v: string) => onChange({ ...form, [k]: v });
  const accountNames = form.accounts.map((a) => a.name.trim()).filter((n) => n !== '');
  const providerNames = form.providers.map((p) => p.name.trim()).filter((n) => n !== '');
  return (
    <div className="space-y-3" data-testid="global-acme-form">
      <p className="text-xs text-gray-700">{SECRET_FILE_NOTE}</p>
      <p className="text-xs text-gray-700">{`指すファイルはすべて同じディレクトリに置き、storage は既定（${ACME_DEFAULT_STORAGE}）かそのディレクトリの下にします。`}</p>
      {masked && (
        <p className="text-xs text-amber-900 rounded-sm border border-amber-300 bg-amber-50 p-2" data-testid="global-acme-masked">
          {`rproxy は秘密に関わる値（ファイルの場所・ヘッダ・本文・URL のパスなど）を ${MASKED} にして返します。${MASKED} の残る欄を入れ直してから送ってください（丸ごと置き換えるため）。`}
        </p>
      )}
      <div className={GRID}>
        <Field id="global-acme-storage" label="storage" value={form.storage} placeholder={`既定 ${ACME_DEFAULT_STORAGE}`} onChange={set('storage')} />
        <Field id="global-acme-http01_listen" label="http01_listen" value={form.http01_listen} placeholder="0.0.0.0:80" onChange={set('http01_listen')} />
        <Field id="global-acme-dns_servers" label="dns_servers" value={form.dns_servers} placeholder="既定 /etc/resolv.conf" onChange={set('dns_servers')} />
        <Field id="global-acme-renew_before" label="renew_before" value={form.renew_before} placeholder="既定 30d" onChange={set('renew_before')} />
        <Field id="global-acme-dns_propagation_timeout" label="dns_propagation_timeout" value={form.dns_propagation_timeout} placeholder="既定 2m" onChange={set('dns_propagation_timeout')} />
        <Field id="global-acme-rate_orders" label="rate_limit.orders" value={form.rate_orders} placeholder="既定 10" onChange={set('rate_orders')} />
        <Field id="global-acme-rate_period" label="rate_limit.period" value={form.rate_period} placeholder="既定 1h" onChange={set('rate_period')} />
        <Field id="global-acme-helper_socket" label="helper.socket" value={form.helper_socket} onChange={set('helper_socket')} />
      </div>
      <div className="space-y-2">
        {form.accounts.map((a, i) => (
          <AccountRow key={i} i={i} a={a} onChange={(x) => onChange({ ...form, accounts: update(form.accounts, i, x) })}
            onRemove={() => onChange({ ...form, accounts: form.accounts.filter((_, j) => j !== i) })} />
        ))}
        <button type="button" className="btn-secondary" data-testid="global-acme-add-account" onClick={() => onChange({ ...form, accounts: [...form.accounts, emptyAccount()] })}>＋ アカウントを足す</button>
      </div>
      <div className="space-y-2">
        {form.providers.map((p, i) => (
          <ProviderRow key={i} i={i} p={p} onChange={(x) => onChange({ ...form, providers: update(form.providers, i, x) })}
            onRemove={() => onChange({ ...form, providers: form.providers.filter((_, j) => j !== i) })} />
        ))}
        <button type="button" className="btn-secondary" data-testid="global-acme-add-provider" onClick={() => onChange({ ...form, providers: [...form.providers, emptyProvider()] })}>＋ DNS のプロバイダを足す</button>
      </div>
      <div className="space-y-2">
        {form.resolvers.map((r, i) => (
          <ResolverRow key={i} i={i} r={r} accounts={accountNames} providers={providerNames}
            onChange={(x) => onChange({ ...form, resolvers: update(form.resolvers, i, x) })}
            onRemove={() => onChange({ ...form, resolvers: form.resolvers.filter((_, j) => j !== i) })} />
        ))}
        <button type="button" className="btn-secondary" data-testid="global-acme-add-resolver" onClick={() => onChange({ ...form, resolvers: [...form.resolvers, emptyResolver()] })}>＋ resolver を足す</button>
      </div>
    </div>
  );
};

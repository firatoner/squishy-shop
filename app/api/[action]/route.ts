import { handleShopRequest, ShopError, type Rpc } from "@/lib/shop-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const rpc: Rpc = async (group, input) => {
  const endpoint = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!endpoint || !key) throw new ShopError(503, "Veritabanı bağlantısı henüz yapılandırılmadı.");

  const headers: Record<string, string> = { apikey: key, "Content-Type": "application/json" };
  if (!key.startsWith("sb_secret_")) headers.Authorization = `Bearer ${key}`;
  const response = await fetch(new URL(`/rest/v1/rpc/shop_${group}`, endpoint), {
    method: "POST", headers, body: JSON.stringify(input), cache: "no-store", signal: AbortSignal.timeout(15_000),
  });
  if (response.ok) return response.json();

  const error: { code?: string; message?: string; details?: string } = await response.json().catch(() => ({}));
  const status = Number(error.details);
  if (error.code === "P0001" && error.message && [400, 404, 409].includes(status)) throw new ShopError(status, error.message);
  console.error("Squishy Shop database request failed", group, response.status, error.code);
  throw new ShopError(503, "Veritabanına şu anda erişilemiyor.");
};

type RouteContext = { params: Promise<{ action: string }> };

async function route(request: Request, context: RouteContext) {
  const { action } = await context.params;
  return handleShopRequest(request, action, {
    rpc,
    setupToken: process.env.SHOP_SETUP_TOKEN,
    secureCookies: process.env.VERCEL === "1" || new URL(request.url).protocol === "https:",
  });
}

export const GET = route;
export const POST = route;

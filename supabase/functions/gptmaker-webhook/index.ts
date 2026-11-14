// GRC + · Recebe os webhooks do GPT Maker em tempo real.
// URL: .../gptmaker-webhook?token=SEGREDO&evento=onNewMessage
// 1) confere o token secreto  2) guarda o evento bruto em "eventos"
// 3) pede a sincronização (que relê a conversa pela API)  4) aplica os alertas do evento.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const API = "https://api.gptmaker.ai/v2";
const BASE = Deno.env.get("SUPABASE_URL")!;
const EVENTOS = [
  "onFirstInteraction", "onStartInteraction", "onNewMessage",
  "onTransfer", "onFinishInteraction", "onLackKnowLedge",
];

const sb = createClient(BASE, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

async function segredo(nome: string): Promise<string> {
  const { data, error } = await sb.rpc("obter_segredo", { nome });
  if (error || !data) throw new Error(`Segredo "${nome}" não encontrado`);
  return data as string;
}

function iguais(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });

// O formato do webhook não é documentado: procura o id do chat onde ele estiver.
function acharChat(payload: unknown): string | null {
  let porChave: string | null = null;
  let porFormato: string | null = null;
  const visitar = (v: unknown, chave: string, pai: string) => {
    if (typeof v === "string") {
      if (!porChave && /^(chatid|contextid|chat_id)$/i.test(chave)) porChave = v;
      if (!porChave && chave === "id" && /^chat$/i.test(pai)) porChave = v;
      if (!porFormato && /^[0-9A-F]{32}-\d{8,}$/.test(v)) porFormato = v;
    } else if (Array.isArray(v)) {
      for (const i of v) visitar(i, chave, pai);
    } else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) visitar(x, k, chave);
    }
  };
  visitar(payload, "", "");
  return porChave ?? porFormato;
}

async function processar(id: number, evento: string, payload: unknown) {
  try {
    const r = await fetch(`${BASE}/functions/v1/gptmaker-sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-sync-token": await segredo("sync_token") },
      body: "{}",
    });
    if (!r.ok) throw new Error(`Sincronização falhou (${r.status})`);

    const chat = acharChat(payload);
    if (chat) {
      if (evento === "onLackKnowLedge") {
        await sb.from("conversas").update({ bot_sem_resposta: true }).eq("id", chat);
      } else if (evento === "onStartInteraction" || evento === "onFinishInteraction") {
        await sb.from("conversas").update({ bot_sem_resposta: false }).eq("id", chat);
      }
    }
    await sb.from("eventos").update({ processado: true }).eq("id", id);
  } catch (e) {
    await sb.from("eventos").update({ erro: e instanceof Error ? e.message : String(e) }).eq("id", id);
  }
}

// Aponta os webhooks de todos os agentes para esta função (o segredo não sai do servidor).
async function configurar() {
  const token = await segredo("gptmaker_api_token");
  const segredoUrl = await segredo("webhook_token");
  const cab = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const ws = (await (await fetch(`${API}/workspaces`, { headers: cab })).json())?.[0]?.id;
  const agentes = (await (await fetch(`${API}/workspace/${ws}/agents`, { headers: cab })).json())?.data ?? [];

  const resultado = [];
  for (const a of agentes) {
    const atual = await (await fetch(`${API}/agent/${a.id}/webhooks`, { headers: cab })).json();
    const novo = { ...atual };
    for (const ev of EVENTOS) {
      novo[ev] = `${BASE}/functions/v1/gptmaker-webhook?token=${segredoUrl}&evento=${ev}`;
    }
    const r = await fetch(`${API}/agent/${a.id}/webhooks`, { method: "PUT", headers: cab, body: JSON.stringify(novo) });
    const depois = await (await fetch(`${API}/agent/${a.id}/webhooks`, { headers: cab })).json();
    resultado.push({
      agente: a.name, status: r.status,
      configurados: EVENTOS.filter((ev) => typeof depois?.[ev] === "string" && depois[ev].includes("gptmaker-webhook")),
    });
  }
  return resultado;
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // Ação administrativa: configurar os webhooks no GPT Maker
  const admin = req.headers.get("x-sync-token");
  if (admin) {
    try {
      if (!iguais(admin, await segredo("sync_token"))) return json({ erro: "Não autorizado" }, 401);
      return json({ ok: true, agentes: await configurar() });
    } catch (e) {
      return json({ ok: false, erro: e instanceof Error ? e.message : String(e) }, 500);
    }
  }

  try {
    const token = url.searchParams.get("token") ?? "";
    if (!token || !iguais(token, await segredo("webhook_token"))) return json({ erro: "Não autorizado" }, 401);
  } catch {
    return json({ erro: "Não autorizado" }, 401);
  }

  if (req.method !== "POST") return json({ ok: true });

  const evento = (url.searchParams.get("evento") ?? "desconhecido").slice(0, 60);
  const texto = await req.text();
  let payload: unknown;
  try { payload = JSON.parse(texto); } catch { payload = { bruto: texto.slice(0, 20000) }; }

  const { data: registro, error } = await sb.from("eventos")
    .insert({ tipo: evento, payload: payload ?? {} }).select("id").single();
  if (error || !registro) return json({ ok: false }, 500);

  // Responde na hora e processa em segundo plano
  // deno-lint-ignore no-explicit-any
  (globalThis as any).EdgeRuntime?.waitUntil(processar(registro.id, evento, payload));
  return json({ ok: true });
});

// GRC + · Backup dos dados.
// - Chamada automática (cabeçalho x-sync-token, pelo agendamento semanal do banco):
//   grava uma cópia compactada no armazenamento privado "backups" e mantém as 8 mais recentes.
// - Chamada por um usuário mestre logado: devolve a cópia para baixar, ou a lista das cópias guardadas.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const TABELAS = ["usuarios", "contatos", "conversas", "atendimentos", "mensagens"];
const BALDE = "backups";
const MANTER = 8;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const json = (corpo: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(corpo), { status, headers: { ...CORS, "Content-Type": "application/json", ...extra } });

function iguais(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function lerTabela(tabela: string) {
  const linhas: unknown[] = [];
  for (let de = 0; ; de += 1000) {
    const { data, error } = await sb.from(tabela).select("*").order("id").range(de, de + 999);
    if (error) throw new Error(`Erro ao ler ${tabela}: ${error.message}`);
    linhas.push(...data);
    if (data.length < 1000) break;
  }
  return linhas;
}

async function gerarCopia() {
  const tabelas: Record<string, unknown[]> = {};
  for (const t of TABELAS) tabelas[t] = await lerTabela(t);
  return {
    sistema: "GRC +",
    gerado_em: new Date().toISOString(),
    contagem: Object.fromEntries(TABELAS.map((t) => [t, tabelas[t].length])),
    tabelas,
  };
}

async function compactar(texto: string): Promise<Uint8Array> {
  const fluxo = new Blob([texto]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(fluxo).arrayBuffer());
}

async function listarCopias() {
  const { data, error } = await sb.storage.from(BALDE).list("", { limit: 100, sortBy: { column: "name", order: "desc" } });
  if (error) throw new Error(error.message);
  return (data ?? []).filter((a) => a.name.endsWith(".json.gz"));
}

async function backupAutomatico() {
  const copia = await gerarCopia();
  const arquivo = `grc-plus-${copia.gerado_em.slice(0, 10)}.json.gz`;
  const bytes = await compactar(JSON.stringify(copia));
  const { error } = await sb.storage.from(BALDE).upload(arquivo, bytes, { contentType: "application/gzip", upsert: true });
  if (error) throw new Error(`Erro ao guardar o backup: ${error.message}`);

  const antigas = (await listarCopias()).slice(MANTER).map((a) => a.name);
  if (antigas.length) await sb.storage.from(BALDE).remove(antigas);
  return { arquivo, bytes: bytes.length, contagem: copia.contagem, removidas: antigas.length };
}

async function usuarioMestre(req: Request): Promise<boolean> {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return false;
  let id: string;
  try {
    id = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).sub;
  } catch {
    return false;
  }
  if (!id) return false;
  // Consulta feita COM o token do usuário: o banco confere a assinatura e aplica as regras de acesso.
  // Um token falso ou vencido é recusado aqui.
  const chave = Deno.env.get("SUPABASE_ANON_KEY") ?? req.headers.get("apikey") ?? "";
  const comoUsuario = createClient(Deno.env.get("SUPABASE_URL")!, chave, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: perfil, error } = await comoUsuario.from("usuarios").select("papel, ativo").eq("id", id).maybeSingle();
  return !error && perfil?.papel === "mestre" && perfil?.ativo === true;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ erro: "Use POST" }, 405);

  try {
    // Agendamento do banco
    const segredo = req.headers.get("x-sync-token");
    if (segredo) {
      const { data: esperado } = await sb.rpc("obter_segredo", { nome: "sync_token" });
      if (!esperado || !iguais(segredo, esperado as string)) return json({ erro: "Não autorizado" }, 401);
      return json({ ok: true, ...(await backupAutomatico()) });
    }

    // Usuário mestre logado
    if (!(await usuarioMestre(req))) return json({ erro: "Somente usuário mestre" }, 403);
    const corpo = await req.json().catch(() => ({}));

    if (corpo?.acao === "listar") {
      const copias = await listarCopias();
      return json({ ok: true, copias: copias.map((a) => ({ arquivo: a.name, criado_em: a.created_at, bytes: a.metadata?.size ?? null })) });
    }
    return json(await gerarCopia());
  } catch (e) {
    return json({ ok: false, erro: e instanceof Error ? e.message : String(e) }, 500);
  }
});

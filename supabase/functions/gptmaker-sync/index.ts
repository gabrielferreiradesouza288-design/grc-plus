// GRC + · Sincronização com a API do GPT Maker (somente leitura, não consome créditos).
// Importa contatos, conversas, atendimentos e mensagens para o banco.
// Chamada protegida pelo cabeçalho x-sync-token (segredo guardado no Vault).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const API = "https://api.gptmaker.ai/v2";
const TAMANHO_PAGINA = 100;

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

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

const data = (ms: unknown) => (typeof ms === "number" && ms > 0 ? new Date(ms).toISOString() : null);
const vazio = (v: unknown) => (v === null || v === undefined || v === "" ? null : String(v));

// deno-lint-ignore no-explicit-any
type Obj = Record<string, any>;

async function api(token: string, caminho: string): Promise<unknown> {
  const r = await fetch(`${API}/${caminho}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`GPT Maker ${r.status} em ${caminho.split("?")[0]}`);
  return await r.json();
}

// Busca todas as páginas de uma listagem (a API devolve ora um array, ora { data: [...] }).
async function listar(token: string, caminho: string): Promise<Obj[]> {
  const tudo: Obj[] = [];
  const vistos = new Set<string>();
  for (let pagina = 1; pagina <= 100; pagina++) {
    const sep = caminho.includes("?") ? "&" : "?";
    const corpo = await api(token, `${caminho}${sep}page=${pagina}&pageSize=${TAMANHO_PAGINA}`);
    const itens: Obj[] = Array.isArray(corpo) ? corpo : ((corpo as Obj)?.data ?? []);
    const novos = itens.filter((i) => i?.id && !vistos.has(i.id));
    if (novos.length === 0) break; // acabou (ou a API repetiu a mesma página)
    for (const i of novos) { vistos.add(i.id); tudo.push(i); }
    if (itens.length < TAMANHO_PAGINA) break;
  }
  return tudo;
}

async function gravar(tabela: string, linhas: Obj[]) {
  for (let i = 0; i < linhas.length; i += 500) {
    const { error } = await sb.from(tabela).upsert(linhas.slice(i, i + 500), { onConflict: "id" });
    if (error) throw new Error(`Erro ao gravar em ${tabela}: ${error.message}`);
  }
}

function etapaDoAtendimento(a: Obj): string {
  if (a.status === "RESOLVED" || a.resolvedAt) return "finalizado";
  if (a.status === "WAITING") return "aguardando_humano";
  if (a.userId) return "humano_atendendo";
  return "bot_atendendo";
}

function autorDaMensagem(m: Obj): { autor: string; autor_nome: string | null } {
  if (m.role === "user") return { autor: "cliente", autor_nome: vazio(m.metadata?.senderName) };
  if (m.role === "system") return { autor: "sistema", autor_nome: vazio(m.userName) };
  if (m.userId) return { autor: "equipe", autor_nome: vazio(m.userName) };
  return { autor: "bot", autor_nome: vazio(m.assistantName ?? m.agentName) };
}

async function sincronizar(completo: boolean) {
  const token = await segredo("gptmaker_api_token");

  const workspaces = (await api(token, "workspaces")) as Obj[];
  const ws = workspaces?.[0]?.id;
  if (!ws) throw new Error("Nenhum workspace encontrado no GPT Maker");

  const [contatos, chats, atendimentos] = await Promise.all([
    listar(token, `workspace/${ws}/contacts`),
    listar(token, `workspace/${ws}/chats`),
    listar(token, `workspace/${ws}/interactions`),
  ]);

  // Contatos (os que só aparecem no chat também entram)
  const linhasContatos = new Map<string, Obj>();
  for (const c of contatos) {
    linhasContatos.set(c.id, {
      id: c.id, nome: c.name ?? "", telefone: vazio(c.phone ?? c.recipient),
      email: vazio(c.email), foto_url: vazio(c.picture),
    });
  }
  for (const c of chats) {
    if (c.contactId && !linhasContatos.has(c.contactId)) {
      linhasContatos.set(c.contactId, {
        id: c.contactId, nome: c.name ?? "", telefone: vazio(c.whatsappPhone ?? c.recipient),
        email: null, foto_url: vazio(c.picture),
      });
    }
  }
  await gravar("contatos", [...linhasContatos.values()]);

  // Atendimento mais recente de cada conversa define a etapa do funil
  const ultimoAtendimento = new Map<string, Obj>();
  const qtdAtendimentos = new Map<string, number>();
  for (const a of atendimentos) {
    qtdAtendimentos.set(a.chatId, (qtdAtendimentos.get(a.chatId) ?? 0) + 1);
    const atual = ultimoAtendimento.get(a.chatId);
    if (!atual || (a.startAt ?? 0) > (atual.startAt ?? 0)) ultimoAtendimento.set(a.chatId, a);
  }

  const idsChats = new Set(chats.map((c) => c.id));
  await gravar("conversas", chats.map((c) => {
    const ult = ultimoAtendimento.get(c.id);
    let etapa = c.humanTalk ? "humano_atendendo" : "bot_atendendo";
    if (c.finished) etapa = "finalizado";
    else if (ult && etapaDoAtendimento(ult) !== "finalizado") etapa = etapaDoAtendimento(ult);
    // Primeiro atendimento do contato, ainda com o bot = novo lead
    if (etapa === "bot_atendendo" && (qtdAtendimentos.get(c.id) ?? 0) <= 1) etapa = "novo_lead";
    return {
      id: c.id, contato_id: vazio(c.contactId), agente_id: vazio(c.agentId), agente_nome: vazio(c.agentName),
      canal_id: vazio(c.channelId), canal_tipo: vazio(c.type), nome: c.name ?? "",
      telefone: vazio(c.whatsappPhone ?? c.recipient), foto_url: vazio(c.picture),
      etapa, humano: !!c.humanTalk, finalizado: !!c.finished, nao_lidas: c.unReadCount ?? 0,
      ultima_mensagem: vazio(c.conversation), ultima_mensagem_em: data(c.time), iniciada_em: data(c.createdAt),
    };
  }));

  await gravar("atendimentos", atendimentos.filter((a) => idsChats.has(a.chatId)).map((a) => ({
    id: a.id, conversa_id: a.chatId,
    contato_id: a.contactId && linhasContatos.has(a.contactId) ? a.contactId : null,
    protocolo: vazio(a.protocol), status_origem: vazio(a.status), etapa: etapaDoAtendimento(a),
    atendente_id: vazio(a.userId), atendente_nome: vazio(a.userName),
    iniciado_em: data(a.startAt), transferido_em: data(a.transferAt), finalizado_em: data(a.resolvedAt),
  })));

  // Mensagens: só das conversas que tiveram novidade desde a última sincronização
  const { data: jaSincronizadas, error } = await sb.from("conversas").select("id, sincronizada_em");
  if (error) throw new Error(error.message);
  const marca = new Map((jaSincronizadas ?? []).map((c) => [c.id, c.sincronizada_em ? Date.parse(c.sincronizada_em) : 0]));

  let totalMensagens = 0;
  let conversasAtualizadas = 0;
  for (const c of chats) {
    const anterior = marca.get(c.id) ?? 0;
    if (!completo && anterior && (c.time ?? 0) <= anterior) continue;

    const mensagens = await listar(token, `chat/${encodeURIComponent(c.id)}/messages`);
    await gravar("mensagens", mensagens.filter((m) => m.time).map((m) => ({
      id: m.id, conversa_id: c.id, ...autorDaMensagem(m),
      tipo: m.type ?? "TEXT", notificacao_tipo: vazio(m.conversationNotificationType),
      protocolo: vazio(m.protocol), texto: vazio(m.text ?? m.midiaContent),
      audio_url: vazio(m.audioUrl), imagem_url: vazio(m.imageUrl), video_url: vazio(m.videoUrl),
      documento_url: vazio(m.documentUrl), arquivo_nome: vazio(m.fileName),
      sequencia: typeof m.sequence === "number" ? m.sequence : null, enviada_em: data(m.time),
    })));
    await sb.from("conversas").update({ sincronizada_em: data(c.time) ?? new Date().toISOString() }).eq("id", c.id);
    totalMensagens += mensagens.length;
    conversasAtualizadas++;
  }

  return {
    contatos: linhasContatos.size, conversas: chats.length, atendimentos: atendimentos.length,
    conversas_com_mensagens_importadas: conversasAtualizadas, mensagens: totalMensagens, completo,
  };
}

Deno.serve(async (req: Request) => {
  const json = (corpo: unknown, status = 200) =>
    new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });

  if (req.method !== "POST") return json({ erro: "Use POST" }, 405);

  try {
    const recebido = req.headers.get("x-sync-token") ?? "";
    if (!recebido || !iguais(recebido, await segredo("sync_token"))) return json({ erro: "Não autorizado" }, 401);
  } catch {
    return json({ erro: "Não autorizado" }, 401);
  }

  const corpo = await req.json().catch(() => ({}));
  const { data: registro } = await sb.from("sincronizacoes").insert({}).select("id").single();

  try {
    const resumo = await sincronizar(corpo?.completo === true);
    if (registro) {
      await sb.from("sincronizacoes")
        .update({ concluida_em: new Date().toISOString(), sucesso: true, resumo }).eq("id", registro.id);
    }
    return json({ ok: true, ...resumo });
  } catch (e) {
    const erro = e instanceof Error ? e.message : String(e);
    if (registro) {
      await sb.from("sincronizacoes")
        .update({ concluida_em: new Date().toISOString(), sucesso: false, erro }).eq("id", registro.id);
    }
    return json({ ok: false, erro }, 500);
  }
});

// GRC + · Gestão de usuários (somente usuário mestre).
// Ações: "criar" (novo login já liberado) e "excluir" (remove o login e o perfil).
// Inativar, mudar papel e mudar permissões são feitos direto na tabela usuarios (regras RLS de mestre).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const PERMISSOES = ["funil", "conversas", "mensagens", "contatos", "editar_contatos", "painel"];
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const URL_BASE = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(URL_BASE, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// Devolve o id de quem chamou se for um usuário mestre ativo; senão, null.
async function mestreQueChamou(req: Request): Promise<string | null> {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  let id: string;
  try {
    id = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).sub;
  } catch {
    return null;
  }
  if (!id) return null;
  // Consulta feita COM o token do usuário: o banco confere a assinatura e aplica as regras de acesso.
  const chave = Deno.env.get("SUPABASE_ANON_KEY") ?? req.headers.get("apikey") ?? "";
  const comoUsuario = createClient(URL_BASE, chave, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: perfil, error } = await comoUsuario.from("usuarios").select("papel, ativo").eq("id", id).maybeSingle();
  return !error && perfil?.papel === "mestre" && perfil?.ativo === true ? id : null;
}

function limparPermissoes(entrada: unknown): Record<string, boolean> {
  const origem = entrada && typeof entrada === "object" ? (entrada as Record<string, unknown>) : {};
  return Object.fromEntries(PERMISSOES.map((p) => [p, origem[p] === true]));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ erro: "Use POST" }, 405);

  try {
    const mestre = await mestreQueChamou(req);
    if (!mestre) return json({ erro: "Somente usuário mestre pode gerenciar usuários." }, 403);
    const corpo = await req.json().catch(() => ({}));

    if (corpo?.acao === "criar") {
      const nome = String(corpo.nome ?? "").trim().slice(0, 80);
      const email = String(corpo.email ?? "").trim().toLowerCase();
      const senha = String(corpo.senha ?? "");
      const papel = corpo.papel === "mestre" ? "mestre" : "usuario";
      if (!nome) return json({ erro: "Informe o nome." }, 400);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ erro: "E-mail inválido." }, 400);
      if (senha.length < 8) return json({ erro: "A senha precisa ter pelo menos 8 caracteres." }, 400);

      const { data, error } = await admin.auth.admin.createUser({
        email, password: senha, email_confirm: true, user_metadata: { nome },
      });
      if (error || !data.user) {
        const m = (error?.message ?? "").toLowerCase();
        if (m.includes("already") || m.includes("registered") || m.includes("exists")) {
          return json({ erro: "Já existe um usuário com este e-mail." }, 400);
        }
        return json({ erro: "Não foi possível criar o usuário." }, 400);
      }

      // O perfil nasce pendente (gatilho do banco); aqui ele é liberado com o papel e as permissões escolhidas
      const { error: erroPerfil } = await admin.from("usuarios")
        .update({ nome, papel, ativo: true, permissoes: limparPermissoes(corpo.permissoes) })
        .eq("id", data.user.id);
      if (erroPerfil) {
        await admin.auth.admin.deleteUser(data.user.id);
        return json({ erro: "Não foi possível criar o perfil do usuário." }, 500);
      }
      return json({ ok: true, id: data.user.id });
    }

    if (corpo?.acao === "excluir") {
      const id = String(corpo.id ?? "");
      if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ erro: "Usuário inválido." }, 400);
      if (id === mestre) return json({ erro: "Você não pode excluir o seu próprio usuário." }, 400);
      const { error } = await admin.auth.admin.deleteUser(id);
      if (error) {
        const ultimo = (error.message ?? "").includes("mestre");
        return json({ erro: ultimo ? "É preciso manter pelo menos um usuário mestre ativo." : "Não foi possível excluir o usuário." }, 400);
      }
      return json({ ok: true });
    }

    return json({ erro: "Ação desconhecida." }, 400);
  } catch (e) {
    return json({ erro: e instanceof Error ? e.message : String(e) }, 500);
  }
});

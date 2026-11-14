// GRC + · login, cadastro, senha mestre e base do CRM.
// A chave abaixo é a chave PÚBLICA do Supabase: sozinha não lê nada (as regras RLS exigem login ativo).
const SUPABASE_URL = "https://agzlflvvpqgtcrajtpnw.supabase.co";
const SUPABASE_CHAVE_PUBLICA = "sb_publishable_veaM0Kt79srfJcqJ6tIA4Q_eQ3v2_Xz";

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_CHAVE_PUBLICA);
const $ = (seletor, raiz = document) => raiz.querySelector(seletor);
const $$ = (seletor, raiz = document) => [...raiz.querySelectorAll(seletor)];

let perfil = null;
let canalTempoReal = null;

// ---------------------------------------------------------------------------
// Utilidades de tela
// ---------------------------------------------------------------------------
const TELAS = ["carregando", "login", "cadastro", "pendente", "app"];

function mostrarTela(nome) {
  for (const t of TELAS) $(`#tela-${t}`).hidden = t !== nome;
  document.body.classList.toggle("em-acesso", nome !== "app");
  $$(".aviso").forEach((a) => (a.hidden = true));
  const primeiro = $(`#tela-${nome} input`);
  if (primeiro && nome !== "app") primeiro.focus();
}

function avisar(form, texto, ok = false) {
  const aviso = $(".aviso", form);
  aviso.textContent = texto;
  aviso.classList.toggle("ok", ok);
  aviso.hidden = false;
}

async function comBotaoOcupado(form, tarefa) {
  const botao = $("button[type=submit]", form);
  const rotulo = botao.textContent;
  botao.disabled = true;
  botao.textContent = "Aguarde…";
  try { await tarefa(); } finally { botao.disabled = false; botao.textContent = rotulo; }
}

function traduzirErro(erro) {
  const m = (erro?.message ?? String(erro)).toLowerCase();
  if (m.includes("invalid login credentials")) return "E-mail ou senha incorretos.";
  if (m.includes("email not confirmed")) return "Confirme seu e-mail pelo link que enviamos antes de entrar.";
  if (m.includes("already registered") || m.includes("already been registered")) return "Já existe um usuário com este e-mail.";
  if (m.includes("signups not allowed") || m.includes("signup is disabled")) return "A criação de usuários está desativada no Supabase.";
  if (m.includes("password should be")) return "A senha é fraca demais. Use pelo menos 8 caracteres.";
  if (m.includes("rate limit") || m.includes("too many")) return "Muitas tentativas. Aguarde alguns minutos.";
  if (m.includes("permission denied") || m.includes("jwt")) return "Sem permissão para ver estes dados. Saia e entre novamente.";
  if (m.includes("failed to fetch") || m.includes("network")) return "Sem conexão com o servidor. Tente de novo.";
  // Mensagens que vêm do nosso banco já estão em português
  return erro?.message ?? "Algo deu errado. Tente de novo.";
}

// ---------------------------------------------------------------------------
// Decide qual tela mostrar conforme a sessão e o perfil
// ---------------------------------------------------------------------------
async function rotear() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { perfil = null; pararTempoReal(); return mostrarTela("login"); }

  const { data, error } = await sb.from("usuarios").select("*").eq("id", session.user.id).maybeSingle();
  if (error || !data) {
    await sb.auth.signOut();
    mostrarTela("login");
    return avisar($("#form-login"), "Não foi possível carregar seu perfil. Entre novamente.");
  }
  perfil = data;

  if (!perfil.ativo) {
    $("#pendente-nome").textContent = perfil.nome || perfil.email;
    return mostrarTela("pendente");
  }
  abrirApp();
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
$("#form-login").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const form = ev.currentTarget;
  const { email, senha } = Object.fromEntries(new FormData(form));
  if (!email || !senha) return avisar(form, "Informe o e-mail e a senha.");

  comBotaoOcupado(form, async () => {
    const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password: senha });
    if (error) return avisar(form, traduzirErro(error));
    form.reset();
    await rotear();
  });
});

// ---------------------------------------------------------------------------
// Cadastro (com opção de usuário mestre)
// ---------------------------------------------------------------------------
$("#quer-mestre").addEventListener("change", (ev) => {
  $("#campo-senha-mestre").hidden = !ev.target.checked;
});

$("#form-cadastro").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const form = ev.currentTarget;
  const d = Object.fromEntries(new FormData(form));
  const querMestre = $("#quer-mestre").checked;

  if (!d.nome.trim() || !d.email.trim()) return avisar(form, "Preencha o nome e o e-mail.");
  if (d.senha.length < 8) return avisar(form, "A senha precisa ter pelo menos 8 caracteres.");
  if (d.senha !== d.senha2) return avisar(form, "As duas senhas não são iguais.");
  if (querMestre && !d.senhaMestre) return avisar(form, "Informe a senha mestre.");

  comBotaoOcupado(form, async () => {
    const { data, error } = await sb.auth.signUp({
      email: d.email.trim(),
      password: d.senha,
      options: { data: { nome: d.nome.trim() }, emailRedirectTo: location.origin + location.pathname },
    });
    if (error) return avisar(form, traduzirErro(error));

    // O Supabase devolve um usuário "vazio" quando o e-mail já existe
    if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
      return avisar(form, "Já existe um usuário com este e-mail.");
    }

    if (!data.session) {
      // Confirmação de e-mail ligada: ainda não há sessão
      form.reset();
      $("#campo-senha-mestre").hidden = true;
      return avisar(form, querMestre
        ? "Usuário criado. Confirme pelo link enviado ao seu e-mail, entre e informe a senha mestre na tela seguinte."
        : "Usuário criado. Confirme pelo link enviado ao seu e-mail e depois entre.", true);
    }

    if (querMestre) {
      const { data: virou, error: erroMestre } = await sb.rpc("tornar_mestre", { senha_mestre: d.senhaMestre });
      form.reset();
      $("#campo-senha-mestre").hidden = true;
      await rotear();
      if (erroMestre || !virou) {
        avisar($("#form-mestre"), erroMestre ? traduzirErro(erroMestre) : "Usuário criado, mas a senha mestre está incorreta.");
      }
      return;
    }
    form.reset();
    await rotear();
  });
});

// ---------------------------------------------------------------------------
// Tela de pendente: virar mestre com a senha mestre
// ---------------------------------------------------------------------------
$("#form-mestre").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const form = ev.currentTarget;
  const { senhaMestre } = Object.fromEntries(new FormData(form));
  if (!senhaMestre) return avisar(form, "Informe a senha mestre.");

  comBotaoOcupado(form, async () => {
    const { data: virou, error } = await sb.rpc("tornar_mestre", { senha_mestre: senhaMestre });
    form.reset();
    if (error) return avisar(form, traduzirErro(error));
    if (!virou) return avisar(form, "Senha mestre incorreta.");
    await rotear();
  });
});

$("#pendente-atualizar").addEventListener("click", async () => {
  await rotear();
  if (perfil && !perfil.ativo) avisar($("#form-mestre"), "Seu acesso ainda não foi liberado.");
});

// Navegação entre login e cadastro, e sair
document.addEventListener("click", async (ev) => {
  const ir = ev.target.closest("[data-ir]");
  if (ir) return mostrarTela(ir.dataset.ir);
  if (ev.target.closest("[data-acao=sair]")) {
    await sb.auth.signOut();
    await rotear();
  }
});

// ---------------------------------------------------------------------------
// CRM (base): menu, resumo do funil e gestão de usuários
// ---------------------------------------------------------------------------
// página: [título, sobretítulo]
const PAGINAS = {
  funil: ["Funil de atendimento", "Atendimento"],
  conversas: ["Conversas", "Atendimento"],
  contatos: ["Contatos", "Clientes"],
  painel: ["Painel", "Indicadores"],
  ajustes: ["Ajustes", "Administração"],
};

const ETAPAS = [
  ["novo_lead", "Novo lead", "var(--ciano)"],
  ["bot_atendendo", "Bot atendendo", "var(--verde)"],
  ["aguardando_humano", "Aguardando humano", "var(--dourado)"],
  ["humano_atendendo", "Humano atendendo", "#8ab4f8"],
  ["finalizado", "Finalizado", "var(--neutro)"],
];

function iniciais(nome) {
  const partes = (nome ?? "").trim().split(/\s+/).filter((p) => /\p{L}/u.test(p));
  if (!partes.length) return "?";
  return (partes[0][0] + (partes.length > 1 ? partes[partes.length - 1][0] : "")).toUpperCase();
}

function abrirApp() {
  const nome = perfil.nome || perfil.email;
  $("#usuario-nome").textContent = nome;
  $("#usuario-avatar").textContent = iniciais(nome);
  $("#usuario-papel").textContent = perfil.papel === "mestre" ? "Usuário mestre" : "Usuário";
  mostrarTela("app");
  abrirPagina("funil");
  iniciarTempoReal();
}

function abrirPagina(nome) {
  for (const p of Object.keys(PAGINAS)) $(`#pagina-${p}`).hidden = p !== nome;
  $$(".lateral nav button").forEach((b) => b.classList.toggle("ativo", b.dataset.pagina === nome));
  $("#pagina-titulo").textContent = PAGINAS[nome][0];
  $("#pagina-sobretitulo").textContent = PAGINAS[nome][1];
  $("#periodo-caixa").hidden = !PAGINAS_DE_CONVERSAS.includes(nome);
  $("#busca-caixa").hidden = !PAGINAS_DE_CONVERSAS.includes(nome) && nome !== "contatos";
  $("#busca-funil").placeholder = nome === "contatos" ? "Buscar nome, número ou etiqueta" : "Buscar contato ou número";
  if (nome === "contatos") carregarContatos();
  if (nome === "painel") carregarPainel();
  fecharConversa();
  foco = null;
  if (PAGINAS_DE_CONVERSAS.includes(nome)) carregarFunil();
  if (nome === "conversas" && selecionada) focarSelecionada(true);
  if (nome === "ajustes") carregarUsuarios();
}

$$(".lateral nav button").forEach((b) => b.addEventListener("click", () => abrirPagina(b.dataset.pagina)));

const el = (tag, classe, texto) => {
  const e = document.createElement(tag);
  if (classe) e.className = classe;
  if (texto !== undefined) e.textContent = texto;
  return e;
};

function formatarTelefone(t) {
  const n = (t ?? "").replace(/\D/g, "");
  const m = n.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `+55 (${m[1]}) ${m[2]}-${m[3]}` : (t ?? "");
}

function haQuanto(iso) {
  if (!iso) return "";
  const min = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60000));
  if (min < 1) return "agora";
  if (min < 60) return `${min} min`;
  if (min < 1440) return `${Math.floor(min / 60)} h`;
  const dias = Math.floor(min / 1440);
  return dias === 1 ? "1 dia" : `${dias} dias`;
}

// ---------------------------------------------------------------------------
// Funil em colunas
// ---------------------------------------------------------------------------
const MAX_FINALIZADOS = 30;
const PAGINAS_DE_CONVERSAS = ["funil", "conversas"];
const paginaVisivel = (nome) => !$("#tela-app").hidden && !$(`#pagina-${nome}`).hidden;
let foco = null;          // { id, caixa }: conversa cujas mensagens estão na tela
let selecionada = null;   // id da conversa aberta na tela Conversas
let filtroLista = "todas";
let conversas = [];
let atendimentosAbertos = new Map(); // conversa_id -> atendimento em aberto

async function carregarFunil() {
  const [c, a] = await Promise.all([
    sb.from("conversas")
      .select("id, nome, telefone, etapa, bot_sem_resposta, nao_lidas, ultima_mensagem, ultima_mensagem_em")
      .order("ultima_mensagem_em", { ascending: false, nullsFirst: false }),
    sb.from("atendimentos").select("conversa_id, atendente_nome, transferido_em, iniciado_em").neq("etapa", "finalizado"),
  ]);
  const aviso = $("#funil-aviso");
  aviso.hidden = !c.error;
  if (c.error) { aviso.textContent = traduzirErro(c.error); return; }

  conversas = c.data;
  atendimentosAbertos = new Map((a.data ?? []).map((x) => [x.conversa_id, x]));
  desenhar();
}

function desenhar() {
  if (paginaVisivel("funil")) desenharFunil();
  if (paginaVisivel("conversas")) desenharLista();
  if (paginaVisivel("contatos")) desenharContatos();
}

function buscarConversas() {
  const termo = $("#busca-funil").value.trim().toLowerCase();
  const digitos = termo.replace(/\D/g, "");
  const [de, ate] = periodoEscolhido();
  return conversas.filter((c) => {
    if (termo && !((c.nome ?? "").toLowerCase().includes(termo) || (digitos && (c.telefone ?? "").includes(digitos)))) return false;
    if (de === null && ate === null) return true;
    const quando = c.ultima_mensagem_em ? Date.parse(c.ultima_mensagem_em) : NaN;
    if (Number.isNaN(quando)) return false;
    return (de === null || quando >= de) && (ate === null || quando < ate);
  });
}

// Período escolhido, pela data da última mensagem: [início, fim) em milissegundos (null = sem limite)
function periodoEscolhido() {
  const opcao = $("#filtro-periodo").value;
  const inicioDoDia = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const DIA = 86400000;
  const hoje = inicioDoDia(new Date());
  if (opcao === "hoje") return [hoje, null];
  if (opcao === "ontem") return [hoje - DIA, hoje];
  if (opcao === "7" || opcao === "30") return [hoje - (Number(opcao) - 1) * DIA, null];
  if (opcao === "datas") {
    const ler = (v) => (v ? inicioDoDia(new Date(v + "T00:00:00")) : null);
    const de = ler($("#periodo-de").value);
    const ate = ler($("#periodo-ate").value);
    return [de, ate === null ? null : ate + DIA];
  }
  return [null, null];
}

function aoMudarPeriodo() {
  const opcao = $("#filtro-periodo").value;
  $("#periodo-datas").hidden = opcao !== "datas";
  $("#periodo-caixa").classList.toggle("filtrando", opcao !== "tudo");
  desenhar();
}
["#filtro-periodo", "#periodo-de", "#periodo-ate"].forEach((s) => $(s).addEventListener("change", aoMudarPeriodo));

function desenharFunil() {
  const termo = $("#busca-funil").value.trim() || $("#filtro-periodo").value !== "tudo";
  const filtradas = buscarConversas();

  desenharIndicadores();
  const funil = $("#funil");
  funil.replaceChildren();

  for (const [chave, rotulo, cor] of ETAPAS) {
    let lista = filtradas.filter((c) => c.etapa === chave);
    const total = lista.length;
    // Quem espera há mais tempo aparece primeiro
    if (chave === "aguardando_humano") lista = [...lista].reverse();
    if (chave === "finalizado") lista = lista.slice(0, MAX_FINALIZADOS);

    const coluna = el("section", "coluna");
    coluna.style.setProperty("--cor", cor);
    const titulo = el("h2");
    titulo.append(el("i"), rotulo, el("span", "", String(total)));
    const cards = el("div", "cards");
    for (const c of lista) cards.append(criarCard(c));
    if (!lista.length) cards.append(el("p", "vazio", termo ? "Nada encontrado" : "Nenhuma conversa"));
    if (total > lista.length) cards.append(el("p", "mais", `+ ${total - lista.length} mais antigas`));
    coluna.append(titulo, cards);
    funil.append(coluna);
  }
}

function desenharIndicadores() {
  const hoje = new Date().toDateString();
  const conta = (teste) => conversas.filter(teste).length;
  const dados = [
    ["Em atendimento", conta((c) => c.etapa !== "finalizado")],
    ["Aguardando humano", conta((c) => c.etapa === "aguardando_humano"), true],
    ["Finalizadas hoje", conta((c) => c.etapa === "finalizado" && c.ultima_mensagem_em && new Date(c.ultima_mensagem_em).toDateString() === hoje)],
    ["Mensagens não lidas", conversas.reduce((s, c) => s + (c.etapa === "finalizado" ? 0 : c.nao_lidas ?? 0), 0)],
  ];
  const caixa = $("#indicadores");
  caixa.replaceChildren();
  for (const [rotulo, valor, atencao] of dados) {
    const bloco = el("div", "indicador" + (atencao && valor > 0 ? " atencao" : ""));
    bloco.append(el("div", "rotulo", rotulo), el("div", "valor", String(valor)));
    caixa.append(bloco);
  }
}

function criarCard(c) {
  const aguardando = c.etapa === "aguardando_humano";
  const card = el("button", "card" + (aguardando ? " alerta" : ""));
  card.type = "button";

  const titulo = c.nome || formatarTelefone(c.telefone) || "Sem nome";
  const nome = el("div", "nome");
  nome.append(el("b", "", titulo));
  if (c.nao_lidas > 0 && c.etapa !== "finalizado") nome.append(el("span", "nao-lidas", String(c.nao_lidas)));
  card.append(el("span", "avatar", iniciais(c.nome)), nome);

  const atendimento = atendimentosAbertos.get(c.id);
  if (c.etapa === "humano_atendendo" && atendimento?.atendente_nome) {
    card.append(el("div", "linha", `Com ${atendimento.atendente_nome}`));
  } else {
    card.append(el("div", "linha", c.ultima_mensagem || formatarTelefone(c.telefone)));
  }

  const desde = aguardando ? (atendimento?.transferido_em ?? c.ultima_mensagem_em) : c.ultima_mensagem_em;
  const tempo = haQuanto(desde);
  const rodape = el("div", "rodape");
  rodape.append(el("span", "", aguardando ? `Esperando ${tempo === "agora" ? "há instantes" : "há " + tempo}`
    : tempo === "agora" ? "Agora" : `Há ${tempo}`));
  if (c.bot_sem_resposta && c.etapa !== "finalizado") rodape.append(el("span", "sem-resposta", "Bot sem resposta"));
  card.append(rodape);

  card.addEventListener("click", () => abrirConversa(c));
  return card;
}

$("#busca-funil").addEventListener("input", desenhar);
// Mantém os "há X min" atualizados
setInterval(() => { if (perfil?.ativo) desenhar(); }, 30000);

// ---------------------------------------------------------------------------
// Tela Conversas: lista à esquerda, histórico à direita
// ---------------------------------------------------------------------------
const FILTROS = {
  todas: () => true,
  abertas: (c) => c.etapa !== "finalizado",
  aguardando: (c) => c.etapa === "aguardando_humano",
  finalizadas: (c) => c.etapa === "finalizado",
};

function desenharLista() {
  const lista = buscarConversas().filter(FILTROS[filtroLista]);
  const caixa = $("#lista-conversas");
  const rolagem = caixa.scrollTop;
  caixa.replaceChildren();
  if (!lista.length) caixa.append(el("p", "vazio", "Nenhuma conversa encontrada."));

  for (const c of lista) {
    const aguardando = c.etapa === "aguardando_humano";
    const item = el("button", "item" + (c.id === selecionada ? " ativo" : "") + (aguardando ? " alerta" : ""));
    item.type = "button";
    const avatar = el("span", "avatar", iniciais(c.nome));
    const ponto = el("i");
    ponto.style.setProperty("--cor", ETAPAS.find(([k]) => k === c.etapa)?.[2] ?? "var(--neutro)");
    ponto.title = ETAPAS.find(([k]) => k === c.etapa)?.[1] ?? "";
    avatar.append(ponto);

    const tempo = haQuanto(c.ultima_mensagem_em);
    const previa = aguardando ? "Aguardando atendimento humano" : (c.ultima_mensagem || formatarTelefone(c.telefone));
    item.append(avatar, el("span", "nome", c.nome || formatarTelefone(c.telefone) || "Sem nome"), el("span", "hora", tempo),
      el("span", "previa", previa));
    if (c.nao_lidas > 0 && c.etapa !== "finalizado") item.append(el("span", "nao-lidas", String(c.nao_lidas)));
    item.addEventListener("click", () => { selecionada = c.id; focarSelecionada(true); desenharLista(); });
    caixa.append(item);
  }
  caixa.scrollTop = rolagem;
  preencherCabecalhoSelecionada();
}

function preencherCabecalhoSelecionada() {
  const c = conversas.find((x) => x.id === selecionada);
  $("#conv-painel").hidden = !c;
  $("#conv-vazio").hidden = !!c;
  $("#pagina-conversas").classList.toggle("com-conversa", !!c);
  if (!c) return;
  const etapa = ETAPAS.find(([k]) => k === c.etapa);
  $("#conv-nome").textContent = c.nome || "Sem nome";
  $("#conv-telefone").textContent = formatarTelefone(c.telefone);
  $("#conv-avatar").textContent = iniciais(c.nome);
  $("#conv-etapa").textContent = etapa?.[1] ?? "";
  $("#conv-etapa").style.setProperty("--cor", etapa?.[2] ?? "var(--neutro)");
}

function focarSelecionada(rolarParaFim) {
  preencherCabecalhoSelecionada();
  const caixa = $("#conv-mensagens");
  if (foco?.id !== selecionada) caixa.replaceChildren(el("p", "apoio", "Carregando…"));
  foco = { id: selecionada, caixa };
  carregarMensagens(rolarParaFim);
}

$$("#filtros-conversas button").forEach((b) => b.addEventListener("click", () => {
  filtroLista = b.dataset.filtro;
  $$("#filtros-conversas button").forEach((x) => x.classList.toggle("ativo", x === b));
  desenharLista();
}));

$("#conv-voltar").addEventListener("click", () => { selecionada = null; foco = null; desenharLista(); });

// ---------------------------------------------------------------------------
// Tela Contatos: lista pesquisável e ficha (dados, etiquetas, anotações, linha do tempo)
// ---------------------------------------------------------------------------
const MAX_ETIQUETAS = 12;
let contatos = [];
let contatoSelecionado = null;

async function carregarContatos() {
  const { data, error } = await sb.from("contatos")
    .select("id, nome, telefone, email, etiquetas, anotacoes, criado_em").order("nome");
  if (error) {
    $("#contatos-contagem").textContent = traduzirErro(error);
    return;
  }
  contatos = data;
  desenharContatos();
  if (contatoSelecionado) abrirFicha();
}

function desenharContatos() {
  const termo = $("#busca-funil").value.trim().toLowerCase();
  const digitos = termo.replace(/\D/g, "");
  const lista = !termo ? contatos : contatos.filter((c) =>
    (c.nome ?? "").toLowerCase().includes(termo) || (digitos && (c.telefone ?? "").includes(digitos)) ||
    (c.etiquetas ?? []).some((e) => e.toLowerCase().includes(termo)));

  $("#contatos-contagem").textContent = lista.length === 1 ? "1 contato" : `${lista.length} contatos`;
  const caixa = $("#lista-contatos");
  const rolagem = caixa.scrollTop;
  caixa.replaceChildren();
  if (!lista.length) caixa.append(el("p", "vazio", "Nenhum contato encontrado."));

  for (const c of lista) {
    const item = el("button", "item" + (c.id === contatoSelecionado ? " ativo" : ""));
    item.type = "button";
    item.append(el("span", "avatar", iniciais(c.nome)), el("span", "nome", c.nome || "Sem nome"), el("span", "hora"),
      el("span", "previa", formatarTelefone(c.telefone)));
    if (c.etiquetas?.length) item.lastChild.append(el("span", "chips", "  ·  " + c.etiquetas.join(", ")));
    item.addEventListener("click", () => { contatoSelecionado = c.id; desenharContatos(); abrirFicha(); });
    caixa.append(item);
  }
  caixa.scrollTop = rolagem;
}

const dataCurta = (iso) => new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" });
const dataHora = (iso) => `${dataCurta(iso)}, ${new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;

function duracao(inicio, fim) {
  const min = Math.max(0, Math.round((Date.parse(fim) - Date.parse(inicio)) / 60000));
  if (min < 1) return "menos de 1 min";
  if (min < 60) return `${min} min`;
  if (min < 1440) return `${Math.floor(min / 60)} h ${min % 60} min`;
  return `${Math.floor(min / 1440)} d ${Math.floor((min % 1440) / 60)} h`;
}

async function abrirFicha() {
  const c = contatos.find((x) => x.id === contatoSelecionado);
  $("#ficha").hidden = !c;
  $("#ficha-vazio").hidden = !!c;
  $("#pagina-contatos").classList.toggle("com-conversa", !!c);
  if (!c) return;

  $("#ficha-nome").textContent = c.nome || "Sem nome";
  $("#ficha-avatar").textContent = iniciais(c.nome);
  $("#ficha-contato").textContent = [formatarTelefone(c.telefone), c.email].filter(Boolean).join(" · ");
  desenharEtiquetas(c);
  // Não sobrescreve o que a pessoa está digitando
  const campo = $("#ficha-anotacoes");
  if (campo.dataset.contato !== c.id) {
    campo.value = c.anotacoes ?? "";
    campo.dataset.contato = c.id;
    $("#ficha-status").textContent = "";
  }

  const linha = $("#ficha-linha-tempo");
  linha.replaceChildren(el("li", "vazio", "Carregando…"));
  $("#ficha-conversas").replaceChildren();
  $("#ficha-resumo").replaceChildren();

  const [a, cv] = await Promise.all([
    sb.from("atendimentos").select("id, protocolo, etapa, atendente_nome, iniciado_em, transferido_em, finalizado_em")
      .eq("contato_id", c.id).order("iniciado_em", { ascending: false }),
    sb.from("conversas").select("id, nome, telefone, etapa, iniciada_em, ultima_mensagem_em").eq("contato_id", c.id),
  ]);
  if (contatoSelecionado !== c.id) return; // já escolheu outro contato
  linha.replaceChildren();
  if (a.error) return linha.append(el("li", "vazio", traduzirErro(a.error)));

  const atend = a.data;
  const conv = cv.data ?? [];
  const primeiro = [...atend.map((x) => x.iniciado_em), ...conv.map((x) => x.iniciada_em)].filter(Boolean).sort()[0];
  const ultimo = conv.map((x) => x.ultima_mensagem_em).filter(Boolean).sort().pop();
  for (const [rotulo, valor] of [
    ["Primeiro contato", primeiro ? dataCurta(primeiro) : "Sem registro"],
    ["Atendimentos", String(atend.length)],
    ["Última mensagem", ultimo ? `há ${haQuanto(ultimo)}`.replace("há agora", "agora") : "Sem registro"],
  ]) {
    const bloco = el("div");
    bloco.append(el("div", "rotulo", rotulo), el("div", "valor", valor));
    $("#ficha-resumo").append(bloco);
  }

  for (const conversa of conv) {
    const botao = el("button", "botao", "Ver conversa");
    botao.type = "button";
    botao.addEventListener("click", () => abrirConversa(conversa));
    $("#ficha-conversas").append(botao);
  }

  if (!atend.length) linha.append(el("li", "vazio", "Nenhum atendimento registrado."));
  for (const x of atend) {
    const etapa = ETAPAS.find(([k]) => k === x.etapa);
    const li = el("li");
    li.style.setProperty("--cor", etapa?.[2] ?? "var(--neutro)");
    li.append(el("div", "titulo", `${x.protocolo ? `Protocolo ${x.protocolo}` : "Atendimento"} · ${etapa?.[1] ?? ""}`));
    const partes = [x.iniciado_em ? dataHora(x.iniciado_em) : "Sem data"];
    if (x.iniciado_em && x.finalizado_em) partes.push(`durou ${duracao(x.iniciado_em, x.finalizado_em)}`);
    if (x.transferido_em) partes.push("transferido para humano");
    if (x.atendente_nome) partes.push(`com ${x.atendente_nome}`);
    li.append(el("div", "detalhe", partes.join(" · ")));
    linha.append(li);
  }
}

function desenharEtiquetas(c) {
  const caixa = $("#ficha-etiquetas");
  caixa.replaceChildren();
  for (const e of c.etiquetas ?? []) {
    const chip = el("span", "chip", e);
    const remover = el("button", "", "×");
    remover.type = "button";
    remover.setAttribute("aria-label", `Remover etiqueta ${e}`);
    remover.addEventListener("click", () => salvarEtiquetas(c, c.etiquetas.filter((x) => x !== e)));
    chip.append(remover);
    caixa.append(chip);
  }
}

async function salvarEtiquetas(c, etiquetas) {
  const { error } = await sb.from("contatos").update({ etiquetas }).eq("id", c.id);
  if (error) { $("#ficha-status").textContent = traduzirErro(error); return; }
  c.etiquetas = etiquetas;
  desenharEtiquetas(c);
  desenharContatos();
}

$("#form-etiqueta").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const campo = ev.currentTarget.etiqueta;
  const nova = campo.value.trim().replace(/\s+/g, " ");
  const c = contatos.find((x) => x.id === contatoSelecionado);
  if (!c || !nova) return;
  const atuais = c.etiquetas ?? [];
  if (atuais.some((e) => e.toLowerCase() === nova.toLowerCase())) { campo.value = ""; return; }
  if (atuais.length >= MAX_ETIQUETAS) { $("#ficha-status").textContent = `Limite de ${MAX_ETIQUETAS} etiquetas por contato.`; return; }
  campo.value = "";
  await salvarEtiquetas(c, [...atuais, nova]);
});

$("#ficha-salvar").addEventListener("click", async (ev) => {
  const c = contatos.find((x) => x.id === contatoSelecionado);
  if (!c) return;
  const botao = ev.currentTarget;
  const status = $("#ficha-status");
  const anotacoes = $("#ficha-anotacoes").value;
  botao.disabled = true;
  const { error } = await sb.from("contatos").update({ anotacoes }).eq("id", c.id);
  botao.disabled = false;
  if (error) { status.textContent = traduzirErro(error); return; }
  c.anotacoes = anotacoes;
  status.textContent = `Salvo às ${new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
});

$("#ficha-voltar").addEventListener("click", () => { contatoSelecionado = null; desenharContatos(); abrirFicha(); });

// ---------------------------------------------------------------------------
// Painel de indicadores
// ---------------------------------------------------------------------------
let painelDias = 30;
const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

function minutosLegiveis(min) {
  if (min === null || min === undefined) return ["–", ""];
  if (min < 60) return [String(min).replace(".", ","), "min"];
  if (min < 1440) return [(min / 60).toFixed(1).replace(".", ","), "h"];
  return [(min / 1440).toFixed(1).replace(".", ","), "dias"];
}

async function carregarPainel() {
  const DIA = 86400000;
  const agora = new Date();
  const hoje = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate());
  const inicio = new Date(hoje.getTime() - (painelDias - 1) * DIA);
  const fim = new Date(hoje.getTime() + DIA);
  $("#painel-intervalo").textContent = `${dataCurta(inicio)} a ${dataCurta(hoje)}`;

  const { data: d, error } = await sb.rpc("painel_indicadores", {
    p_inicio: inicio.toISOString(), p_fim: fim.toISOString(),
    p_fuso: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Sao_Paulo",
  });
  const aviso = $("#painel-aviso");
  aviso.hidden = !error;
  if (error) { aviso.textContent = traduzirErro(error); return; }

  // Cartões
  const taxa = d.atendimentos ? Math.round((d.transferidos / d.atendimentos) * 100) : 0;
  const [espera, esperaUn] = minutosLegiveis(d.espera_media_min);
  const [dur, durUn] = minutosLegiveis(d.duracao_media_min);
  const tiles = [
    ["Atendimentos", d.atendimentos, "", `${(d.atendimentos / painelDias).toFixed(1).replace(".", ",")} por dia, em média`],
    ["Novos contatos", d.novos_contatos, "", "Primeira conversa no período"],
    ["Transferidos para humano", d.transferidos, "", d.atendimentos ? `${taxa}% dos atendimentos` : "Sem atendimentos no período"],
    ["Espera média por um humano", espera, esperaUn, d.esperas_medidas ? `Medida em ${plural(d.esperas_medidas, "transferência", "transferências")}` : "Sem transferências assumidas"],
    ["Duração média do atendimento", dur, durUn, "Do início ao encerramento"],
    ["Bot sem resposta", d.bot_sem_resposta ?? "–", "", d.bot_sem_resposta === null ? "Visível só para usuário mestre" : "Perguntas que o bot não soube responder"],
  ];
  const caixa = $("#painel-tiles");
  caixa.replaceChildren();
  for (const [rotulo, valor, unidade, nota] of tiles) {
    const tile = el("div", "tile");
    const v = el("div", "valor", String(valor));
    if (unidade) v.append(el("small", "", unidade));
    tile.append(el("div", "rotulo", rotulo), v, el("div", "nota", nota));
    caixa.append(tile);
  }

  // Atendimentos por dia (dias sem atendimento entram como zero)
  const porDia = new Map(d.por_dia.map((x) => [x.dia, x.n]));
  const dias = [];
  for (let t = inicio.getTime(); t < fim.getTime(); t += DIA) {
    const dt = new Date(t);
    const chave = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
    dias.push({
      n: porDia.get(chave) ?? 0,
      curto: dt.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }),
      longo: dt.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long" }),
    });
  }
  const passoDia = Math.ceil(dias.length / 8);
  desenharBarras("dia", dias.map((x, i) => ({
    n: x.n, eixo: i % passoDia === 0 ? x.curto : "", titulo: x.longo, unidade: ["atendimento", "atendimentos"],
  })));
  const melhor = dias.reduce((a, b) => (b.n > a.n ? b : a), dias[0]);
  $("#grafico-dia-resumo").textContent = melhor.n ? `Dia mais movimentado: ${melhor.longo}, com ${plural(melhor.n, "atendimento", "atendimentos")}.` : "Nenhum atendimento no período.";

  // Horários de pico (mensagens recebidas dos clientes, por hora do dia)
  const porHora = new Map(d.por_hora.map((x) => [x.hora, x.n]));
  const horas = Array.from({ length: 24 }, (_, h) => ({ h, n: porHora.get(h) ?? 0 }));
  desenharBarras("hora", horas.map((x) => ({
    n: x.n, eixo: x.h % 3 === 0 ? `${x.h}h` : "", titulo: `Das ${x.h}h às ${x.h + 1}h`, unidade: ["mensagem de cliente", "mensagens de clientes"],
  })));
  const pico = horas.reduce((a, b) => (b.n > a.n ? b : a), horas[0]);
  $("#grafico-hora-resumo").textContent = pico.n
    ? `Pico entre ${pico.h}h e ${pico.h + 1}h. Total de ${plural(d.mensagens_cliente, "mensagem recebida", "mensagens recebidas")} de clientes.`
    : "Nenhuma mensagem de cliente no período.";
}

function desenharBarras(nome, pontos) {
  const area = $(`#grafico-${nome}`);
  const eixo = $(`#grafico-${nome}-eixo`);
  area.replaceChildren();
  eixo.replaceChildren();
  const maximo = Math.max(...pontos.map((p) => p.n));
  area.setAttribute("aria-label", pontos.filter((p) => p.n).map((p) => `${p.titulo}: ${p.n}`).join("; ") || "Sem dados no período");

  for (const p of pontos) {
    const barra = el("div", "pilar" + (p.n === 0 ? " zero" : "") + (p.n === maximo && maximo > 0 ? " pico" : ""));
    barra.tabIndex = 0;
    const preenchimento = el("i");
    preenchimento.style.height = maximo ? `${Math.max(2, (p.n / maximo) * 100)}%` : "2px";
    barra.append(preenchimento);
    const mostrar = () => {
      const dica = $("#dica-grafico");
      const r = preenchimento.getBoundingClientRect();
      dica.replaceChildren(el("b", "", plural(p.n, ...p.unidade)), el("span", "", p.titulo));
      dica.style.left = `${Math.min(window.innerWidth - 110, Math.max(110, r.left + r.width / 2))}px`;
      dica.style.top = `${r.top}px`;
      dica.hidden = false;
    };
    const esconder = () => { $("#dica-grafico").hidden = true; };
    barra.addEventListener("mouseenter", mostrar);
    barra.addEventListener("focus", mostrar);
    barra.addEventListener("mouseleave", esconder);
    barra.addEventListener("blur", esconder);
    area.append(barra);
    eixo.append(el("span", "", p.eixo));
  }
}

$$("#painel-periodos button").forEach((b) => b.addEventListener("click", () => {
  painelDias = Number(b.dataset.dias);
  $$("#painel-periodos button").forEach((x) => x.classList.toggle("ativo", x === b));
  carregarPainel();
}));

// ---------------------------------------------------------------------------
// Conversa aberta a partir do card
// ---------------------------------------------------------------------------
const AVISOS_SISTEMA = {
  TRANSFER_QUEUE: () => "Transferido para a fila de atendimento humano",
  START_INTERACTION_HUMAN: (n) => `${n || "Um atendente"} assumiu o atendimento`,
  FINISH_INTERACTION_HUMAN: (n) => `Atendimento finalizado por ${n || "um atendente"}`,
  START_INTERACTION_AGENT: () => "Atendimento iniciado pelo bot",
  FINISH_INTERACTION_AGENT: () => "Atendimento finalizado pelo bot",
};
const gavetaAberta = () => !$("#gaveta").hidden;

async function abrirConversa(c) {
  foco = { id: c.id, caixa: $("#gaveta-mensagens") };
  $("#gaveta-nome").textContent = c.nome || "Sem nome";
  $("#gaveta-telefone").textContent = formatarTelefone(c.telefone);
  const etapa = ETAPAS.find(([chave]) => chave === c.etapa);
  const tag = $("#gaveta-etapa");
  tag.textContent = etapa?.[1] ?? "";
  tag.style.setProperty("--cor", etapa?.[2] ?? "var(--neutro)");
  $("#gaveta-avatar").textContent = iniciais(c.nome);
  $("#gaveta-mensagens").replaceChildren(el("p", "apoio", "Carregando…"));
  $("#gaveta").hidden = $("#gaveta-fundo").hidden = false;
  $("#gaveta-fechar").focus();
  await carregarMensagens(true);
}

async function carregarMensagens(rolarParaFim) {
  if (!foco?.id) return;
  const { id, caixa } = foco;
  const { data, error } = await sb.from("mensagens")
    .select("id, autor, autor_nome, tipo, notificacao_tipo, protocolo, texto, audio_url, imagem_url, video_url, documento_url, arquivo_nome, enviada_em")
    .eq("conversa_id", id).order("enviada_em", { ascending: false }).limit(300);
  if (foco?.id !== id || foco.caixa !== caixa) return; // o usuário já abriu outra conversa

  const noFim = caixa.scrollHeight - caixa.scrollTop - caixa.clientHeight < 60;
  caixa.replaceChildren();
  if (error) return caixa.append(el("p", "apoio", traduzirErro(error)));
  if (!data.length) return caixa.append(el("p", "apoio", "Nenhuma mensagem."));

  let diaAtual = "";
  for (const m of data.reverse()) {
    const quando = new Date(m.enviada_em);
    const dia = quando.toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" });
    if (dia !== diaAtual) { diaAtual = dia; caixa.append(el("div", "dia", dia)); }
    const hora = quando.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

    if (m.autor === "sistema") {
      const texto = AVISOS_SISTEMA[m.notificacao_tipo]?.(m.autor_nome) ?? m.texto ?? "Aviso do sistema";
      caixa.append(el("div", "msg sistema", `${texto}${m.protocolo ? ` · protocolo ${m.protocolo}` : ""} · ${hora}`));
      continue;
    }

    const balao = el("div", `msg ${m.autor}`);
    if (m.texto) balao.append(m.texto);
    for (const [url, rotulo] of [[m.imagem_url, "Imagem"], [m.audio_url, "Áudio"], [m.video_url, "Vídeo"], [m.documento_url, m.arquivo_nome || "Documento"]]) {
      if (!url || !/^https:\/\//.test(url)) continue;
      if (balao.childNodes.length) balao.append("\n");
      const link = el("a", "", `Abrir ${rotulo.toLowerCase()}`);
      link.href = url; link.target = "_blank"; link.rel = "noopener noreferrer";
      balao.append(link);
    }
    if (!balao.childNodes.length) balao.append("(mensagem sem texto)");
    const quem = m.autor === "cliente" ? "" : m.autor === "bot" ? "Bot · " : `${m.autor_nome || "Equipe"} · `;
    balao.append(el("span", "meta", quem + hora));
    caixa.append(balao);
  }
  if (rolarParaFim || noFim) caixa.scrollTop = caixa.scrollHeight;
}

function fecharConversa() {
  if (!gavetaAberta()) return;
  foco = null;
  $("#gaveta").hidden = $("#gaveta-fundo").hidden = true;
}
$("#gaveta-fechar").addEventListener("click", fecharConversa);
$("#gaveta-fundo").addEventListener("click", fecharConversa);
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") fecharConversa(); });

// ---------------------------------------------------------------------------
// Tempo real: o banco avisa quando algo muda
// ---------------------------------------------------------------------------
let esperaFunil = null;

function iniciarTempoReal() {
  if (canalTempoReal) return;
  const recarregarFunil = () => {
    clearTimeout(esperaFunil); // junta várias mudanças seguidas em uma só leitura
    esperaFunil = setTimeout(() => { if (PAGINAS_DE_CONVERSAS.some(paginaVisivel)) carregarFunil(); }, 400);
  };
  canalTempoReal = sb.channel("crm")
    .on("postgres_changes", { event: "*", schema: "public", table: "conversas" }, recarregarFunil)
    .on("postgres_changes", { event: "*", schema: "public", table: "atendimentos" }, recarregarFunil)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "mensagens" }, (ev) => {
      if (foco && ev.new?.conversa_id === foco.id) carregarMensagens(false);
    })
    .subscribe((estado) => {
      const selo = $("#ao-vivo");
      const ligado = estado === "SUBSCRIBED";
      const erro = estado === "CHANNEL_ERROR" || estado === "TIMED_OUT";
      selo.classList.toggle("ligado", ligado);
      selo.classList.toggle("erro", erro);
      $("span", selo).textContent = ligado ? "Ao vivo" : erro ? "Sem conexão" : "Conectando";
      if (ligado && PAGINAS_DE_CONVERSAS.some(paginaVisivel)) carregarFunil(); // recupera o que mudou enquanto estava fora do ar
    });
}

function pararTempoReal() {
  if (canalTempoReal) { sb.removeChannel(canalTempoReal); canalTempoReal = null; }
  fecharConversa();
  foco = null;
  selecionada = null;
}

async function carregarUsuarios() {
  const mestre = perfil.papel === "mestre";
  $("#ajustes-aviso").textContent = mestre
    ? "Libere o acesso de quem se cadastrou e defina quem é mestre."
    : "Somente usuários mestres gerenciam a equipe. Abaixo está o seu usuário.";

  const { data, error } = await sb.from("usuarios").select("*").order("criado_em");
  const corpo = $("#tabela-usuarios tbody");
  corpo.replaceChildren();
  if (error) return ($("#ajustes-aviso").textContent = traduzirErro(error));

  for (const u of data) {
    const linha = document.createElement("tr");
    const celula = (texto) => Object.assign(document.createElement("td"), { textContent: texto });
    const etiqueta = (texto, cor) => {
      const td = document.createElement("td");
      const selo = el("span", "etapa", texto);
      selo.style.setProperty("--cor", cor);
      td.append(selo);
      return td;
    };
    const acoes = document.createElement("td");
    acoes.className = "acoes";

    if (mestre && u.id !== perfil.id) {
      acoes.append(
        botaoUsuario(u.ativo ? "Bloquear" : "Liberar acesso", u, { ativo: !u.ativo }),
        botaoUsuario(u.papel === "mestre" ? "Tornar usuário" : "Tornar mestre", u,
          u.papel === "mestre" ? { papel: "usuario" } : { papel: "mestre", ativo: true }),
      );
    }

    linha.append(
      celula(u.nome || "(sem nome)"), celula(u.email),
      etiqueta(u.papel === "mestre" ? "Mestre" : "Usuário", u.papel === "mestre" ? "var(--ciano)" : "var(--neutro)"),
      etiqueta(u.ativo ? "Liberado" : "Pendente", u.ativo ? "var(--verde)" : "var(--dourado)"),
      acoes,
    );
    corpo.append(linha);
  }
}

function botaoUsuario(rotulo, usuario, mudanca) {
  const botao = Object.assign(document.createElement("button"), { type: "button", className: "botao", textContent: rotulo });
  botao.addEventListener("click", async () => {
    botao.disabled = true;
    const { error } = await sb.from("usuarios").update(mudanca).eq("id", usuario.id);
    if (error) $("#ajustes-aviso").textContent = traduzirErro(error);
    await carregarUsuarios();
  });
  return botao;
}

// ---------------------------------------------------------------------------
// Início
// ---------------------------------------------------------------------------
sb.auth.onAuthStateChange((evento) => {
  if (evento === "SIGNED_OUT") { perfil = null; pararTempoReal(); mostrarTela("login"); }
});

rotear().catch(() => mostrarTela("login"));

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
const TELAS = ["carregando", "login", "recuperar", "nova-senha", "pendente", "app"];
// Chegou pelo link de "esqueci minha senha" do e-mail?
let emRecuperacao = /type=recovery/.test(location.hash + location.search);

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
  if (m.includes("different from the old")) return "A nova senha precisa ser diferente da anterior.";
  if (m.includes("expired") || m.includes("invalid") && m.includes("link")) return "Este link expirou. Peça um novo em \"Esqueci minha senha\".";
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
  if (emRecuperacao) return mostrarTela("nova-senha");

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
// Esqueci minha senha: pede o link por e-mail e, ao voltar pelo link, define a nova senha
// ---------------------------------------------------------------------------
$("#form-recuperar").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const form = ev.currentTarget;
  const email = form.email.value.trim();
  if (!email) return avisar(form, "Informe o e-mail.");

  comBotaoOcupado(form, async () => {
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    if (error) return avisar(form, traduzirErro(error));
    form.reset();
    // Mesma resposta exista ou não o usuário, para não revelar quem tem cadastro
    avisar(form, "Se existir um usuário com este e-mail, enviamos um link para criar a nova senha. Confira também a caixa de spam.", true);
  });
});

$("#form-nova-senha").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const form = ev.currentTarget;
  const { senha, senha2 } = Object.fromEntries(new FormData(form));
  if (senha.length < 8) return avisar(form, "A senha precisa ter pelo menos 8 caracteres.");
  if (senha !== senha2) return avisar(form, "As duas senhas não são iguais.");

  comBotaoOcupado(form, async () => {
    const { error } = await sb.auth.updateUser({ password: senha });
    if (error) return avisar(form, traduzirErro(error));
    form.reset();
    emRecuperacao = false;
    history.replaceState(null, "", location.pathname);
    await rotear();
  });
});

// ---------------------------------------------------------------------------
// Tela de acesso desativado: quem tem a senha mestre pode virar usuário mestre
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
  contatos: ["Contatos", "WhatsApp"],
  clientes: ["Clientes", "Fecharam frete"],
  painel: ["Painel", "Indicadores"],
  ajustes: ["Ajustes", "Administração"],
};

const ETAPAS = [
  ["convertido", "Leads convertidos", "var(--ciano)"],
  ["bot_atendendo", "Bot atendendo", "var(--bot, var(--verde))"],
  ["aguardando_humano", "Aguardando humano", "var(--dourado)"],
  ["humano_atendendo", "Humano atendendo", "var(--azul)"],
  ["finalizado", "Finalizado", "var(--neutro)"],
];

// "Convertido" = conversa finalizada de um contato que a equipe já cadastrou em Clientes.
// Se o cliente voltar a falar, a conversa aparece de novo na etapa em que estiver.
function ajustarEtapa(c) {
  if (c.convertido && c.etapa === "finalizado") c.etapa = "convertido";
  else if (c.etapa === "novo_lead") c.etapa = "bot_atendendo";
  return c;
}
const encerrada = (c) => c.etapa === "finalizado" || c.etapa === "convertido";

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
  // O menu mostra só o que o usuário pode ver (Ajustes aparece para todos, com o próprio perfil)
  let primeira = null;
  $$(".lateral nav button").forEach((b) => {
    const visivel = b.dataset.pagina === "ajustes" || pode(b.dataset.pagina);
    b.hidden = !visivel;
    if (visivel && !primeira) primeira = b.dataset.pagina;
  });
  document.body.classList.toggle("sem-abrir-conversas", !pode("mensagens"));
  abrirPagina(primeira ?? "ajustes");
  iniciarTempoReal();
}

function abrirPagina(nome) {
  for (const p of Object.keys(PAGINAS)) $(`#pagina-${p}`).hidden = p !== nome;
  $$(".lateral nav button").forEach((b) => b.classList.toggle("ativo", b.dataset.pagina === nome));
  $("#pagina-titulo").textContent = PAGINAS[nome][0];
  $("#pagina-sobretitulo").textContent = PAGINAS[nome][1];
  $("#periodo-caixa").hidden = !PAGINAS_DE_CONVERSAS.includes(nome);
  $("#busca-caixa").hidden = !PAGINAS_DE_CONVERSAS.includes(nome) && nome !== "contatos" && nome !== "clientes";
  $("#busca-funil").placeholder = nome === "contatos" ? "Buscar nome, número ou etiqueta"
    : nome === "clientes" ? "Buscar nome, CNPJ ou pessoa de contato" : "Buscar contato ou número";
  if (nome === "contatos") carregarContatos();
  if (nome === "clientes") carregarClientes();
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
      .select("id, contato_id, nome, telefone, etapa, convertido, bot_sem_resposta, nao_lidas, ultima_mensagem, ultima_mensagem_em")
      .order("ultima_mensagem_em", { ascending: false, nullsFirst: false }),
    sb.from("atendimentos").select("conversa_id, atendente_nome, transferido_em, iniciado_em").neq("etapa", "finalizado"),
  ]);
  const aviso = $("#funil-aviso");
  aviso.hidden = !c.error;
  if (c.error) { aviso.textContent = traduzirErro(c.error); return; }

  conversas = c.data.map(ajustarEtapa);
  atendimentosAbertos = new Map((a.data ?? []).map((x) => [x.conversa_id, x]));
  desenhar();
}

function desenhar() {
  if (paginaVisivel("funil")) desenharFunil();
  if (paginaVisivel("conversas")) desenharLista();
  if (paginaVisivel("contatos")) desenharContatos();
  if (paginaVisivel("clientes")) desenharClientes();
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
    ["Em atendimento", conta((c) => !encerrada(c))],
    ["Aguardando humano", conta((c) => c.etapa === "aguardando_humano"), true],
    ["Finalizadas hoje", conta((c) => encerrada(c) && c.ultima_mensagem_em && new Date(c.ultima_mensagem_em).toDateString() === hoje)],
    ["Mensagens não lidas", conversas.reduce((s, c) => s + (encerrada(c) ? 0 : c.nao_lidas ?? 0), 0)],
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
  if (c.nao_lidas > 0 && !encerrada(c)) nome.append(el("span", "nao-lidas", String(c.nao_lidas)));
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
  if (c.bot_sem_resposta && !encerrada(c)) rodape.append(el("span", "sem-resposta", "Bot sem resposta"));
  card.append(rodape);

  if (pode("mensagens")) card.addEventListener("click", () => abrirConversa(c));
  else card.disabled = true;
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
  abertas: (c) => !encerrada(c),
  aguardando: (c) => c.etapa === "aguardando_humano",
  finalizadas: (c) => encerrada(c),
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
    if (c.nao_lidas > 0 && !encerrada(c)) item.append(el("span", "nao-lidas", String(c.nao_lidas)));
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
  prepararBotaoCadastrar($("#conv-cadastrar"), c);
}

// Botão "Cadastrar como cliente" na conversa: aparece para quem pode cadastrar e só se ainda não for cliente
function prepararBotaoCadastrar(botao, c) {
  botao.hidden = !(pode("editar_clientes") && c.contato_id && !c.convertido);
  botao.onclick = () => cadastrarContatoComoCliente({ id: c.contato_id, nome: c.nome, telefone: c.telefone });
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
  const podeEditar = pode("editar_contatos");
  campo.readOnly = !podeEditar;
  $("#form-etiqueta").hidden = $("#ficha-salvar").hidden = !podeEditar;
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
    sb.from("conversas").select("id, contato_id, nome, telefone, etapa, convertido, iniciada_em, ultima_mensagem_em").eq("contato_id", c.id),
  ]);
  if (contatoSelecionado !== c.id) return; // já escolheu outro contato
  linha.replaceChildren();
  if (a.error) return linha.append(el("li", "vazio", traduzirErro(a.error)));

  const atend = a.data;
  const conv = (cv.data ?? []).map(ajustarEtapa);
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

  if (pode("editar_clientes")) {
    const botao = el("button", "botao", "Cadastrar como cliente");
    botao.type = "button";
    botao.addEventListener("click", () => cadastrarContatoComoCliente(c));
    $("#ficha-conversas").append(botao);
  }
  for (const conversa of pode("mensagens") ? conv : []) {
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
    if (pode("editar_contatos")) chip.append(remover);
    else chip.style.paddingRight = "10px";
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
// Tela Clientes: cadastro manual, feito pela equipe, de quem fechou frete depois do contato
// ---------------------------------------------------------------------------
let clientes = [];
let clienteSelecionado = null; // id do cliente, "novo" ou null
let clientePreenchido = null;  // dados vindos de um contato do WhatsApp para um cadastro novo
const CAMPOS_CLIENTE = ["nome", "documento", "endereco", "pessoa_contato", "telefone", "email", "observacoes"];

async function carregarClientes() {
  $("#cliente-novo").hidden = !pode("editar_clientes");
  const { data, error } = await sb.from("clientes").select("*").order("nome");
  if (error) { $("#clientes-contagem").textContent = traduzirErro(error); return; }
  clientes = data;
  desenharClientes();
  abrirCliente();
}

function desenharClientes() {
  const termo = $("#busca-funil").value.trim().toLowerCase();
  const digitos = termo.replace(/\D/g, "");
  const lista = !termo ? clientes : clientes.filter((c) =>
    [c.nome, c.pessoa_contato, c.endereco, c.email].some((v) => (v ?? "").toLowerCase().includes(termo)) ||
    (digitos && [c.documento, c.telefone].some((v) => (v ?? "").replace(/\D/g, "").includes(digitos))));

  $("#clientes-contagem").textContent = lista.length === 1 ? "1 cliente" : `${lista.length} clientes`;
  const caixa = $("#lista-clientes");
  const rolagem = caixa.scrollTop;
  caixa.replaceChildren();
  if (!lista.length) caixa.append(el("p", "vazio", clientes.length ? "Nenhum cliente encontrado." : "Nenhum cliente cadastrado ainda."));

  for (const c of lista) {
    const item = el("button", "item" + (c.id === clienteSelecionado ? " ativo" : ""));
    item.type = "button";
    const resumo = [c.pessoa_contato, c.telefone].filter(Boolean).join(" · ") || c.documento || "Sem contato informado";
    item.append(el("span", "avatar", iniciais(c.nome)), el("span", "nome", c.nome),
      el("span", "hora", new Date(c.criado_em).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })),
      el("span", "previa", resumo));
    item.addEventListener("click", () => { clienteSelecionado = c.id; clientePreenchido = null; desenharClientes(); abrirCliente(); });
    caixa.append(item);
  }
  caixa.scrollTop = rolagem;
}

async function abrirCliente() {
  const novo = clienteSelecionado === "novo";
  const c = novo ? (clientePreenchido ?? {}) : clientes.find((x) => x.id === clienteSelecionado);
  const aberto = novo || !!c;
  $("#cliente-ficha").hidden = !aberto;
  $("#cliente-vazio").hidden = aberto;
  $("#pagina-clientes").classList.toggle("com-conversa", aberto);
  if (!aberto) return;

  const podeEditar = pode("editar_clientes");
  const form = $("#form-cliente");
  $("#cliente-titulo").textContent = novo ? "Novo cliente" : c.nome;
  $("#cliente-subtitulo").textContent = novo ? "Preencha os dados de quem fechou frete" : `Cadastrado em ${dataCurta(c.criado_em)}`;
  $("#cliente-avatar").textContent = novo ? "+" : iniciais(c.nome);
  // Não sobrescreve o que a pessoa está digitando ao recarregar a lista
  if (form.dataset.cliente !== String(clienteSelecionado)) {
    form.reset();
    for (const campo of CAMPOS_CLIENTE) form[campo].value = c[campo] ?? "";
    form.dataset.cliente = String(clienteSelecionado);
    $(".aviso", form).hidden = true;
  }
  for (const campo of form.elements) if ("readOnly" in campo) campo.readOnly = !podeEditar;
  $("#cliente-botoes").hidden = !podeEditar;
  $("#cliente-excluir").hidden = novo;
  $("#cliente-excluir").textContent = "Excluir cliente";

  if (novo && podeEditar) form.nome.focus();
}

$("#cliente-novo").addEventListener("click", () => {
  clienteSelecionado = "novo";
  clientePreenchido = null;
  $("#form-cliente").dataset.cliente = "";
  desenharClientes();
  abrirCliente();
});

$("#cliente-voltar").addEventListener("click", () => { clienteSelecionado = null; desenharClientes(); abrirCliente(); });

$("#form-cliente").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const form = ev.currentTarget;
  const texto = (campo) => form[campo].value.trim() || null;
  const dados = {
    nome: form.nome.value.trim(), documento: texto("documento"), endereco: texto("endereco"),
    pessoa_contato: texto("pessoa_contato"), telefone: texto("telefone"), email: texto("email"),
    observacoes: form.observacoes.value.trim(),
  };
  if (!dados.nome) return avisar(form, "Informe o nome ou a razão social.");
  const numeros = (dados.documento ?? "").replace(/\D/g, "");
  if (dados.documento && numeros.length !== 14 && numeros.length !== 11) return avisar(form, "O CNPJ deve ter 14 números (ou 11, se for CPF).");
  if (dados.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(dados.email)) return avisar(form, "E-mail inválido.");

  comBotaoOcupado(form, async () => {
    if (clienteSelecionado === "novo") {
      if (clientePreenchido?.contato_id) dados.contato_id = clientePreenchido.contato_id;
      const { data, error } = await sb.from("clientes").insert(dados).select("id").single();
      if (error) return avisar(form, traduzirErro(error));
      clienteSelecionado = data.id;
      clientePreenchido = null;
    } else {
      const { error } = await sb.from("clientes").update(dados).eq("id", clienteSelecionado);
      if (error) return avisar(form, traduzirErro(error));
    }
    form.dataset.cliente = "";
    await carregarClientes();
    avisar(form, "Cliente salvo.", true);
  });
});

$("#cliente-excluir").addEventListener("click", async (ev) => {
  const botao = ev.currentTarget;
  if (botao.textContent !== "Confirmar exclusão") { botao.textContent = "Confirmar exclusão"; return; }
  botao.disabled = true;
  const { error } = await sb.from("clientes").delete().eq("id", clienteSelecionado);
  botao.disabled = false;
  if (error) return avisar($("#form-cliente"), traduzirErro(error));
  clienteSelecionado = null;
  await carregarClientes();
});

// Atalho na ficha do contato do WhatsApp: abre o cadastro de cliente já com a pessoa e o telefone
function cadastrarContatoComoCliente(contato) {
  clienteSelecionado = "novo";
  clientePreenchido = { pessoa_contato: contato.nome ?? "", telefone: formatarTelefone(contato.telefone), email: contato.email ?? "", contato_id: contato.id };
  $("#form-cliente").dataset.cliente = "";
  abrirPagina("clientes");
}

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
  aviso.hidden = !error && !!d;
  if (error || !d) { aviso.textContent = error ? traduzirErro(error) : "Seu usuário não tem permissão para ver o Painel."; return; }

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
  prepararBotaoCadastrar($("#gaveta-cadastrar"), c);
  $("#gaveta-mensagens").replaceChildren(el("p", "apoio", "Carregando…"));
  $("#gaveta").hidden = $("#gaveta-fundo").hidden = false;
  $("#gaveta-fechar").focus();
  await carregarMensagens(true);
}

async function carregarMensagens(rolarParaFim) {
  if (!foco?.id) return;
  const { id, caixa } = foco;
  if (!pode("mensagens")) {
    caixa.replaceChildren(el("p", "sem-permissao", "Seu usuário não tem permissão para abrir conversas."));
    return;
  }
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

// Backup (só usuário mestre)
async function carregarBackups() {
  const mestre = perfil.papel === "mestre";
  $("#secao-backup").hidden = !mestre;
  if (!mestre) return;
  const { data, error } = await sb.functions.invoke("backup", { body: { acao: "listar" } });
  const ultimo = data?.copias?.[0];
  $("#backup-ultimo").textContent = error ? "Não foi possível consultar as cópias automáticas."
    : ultimo ? `Última cópia automática: ${dataHora(ultimo.criado_em)} (${data.copias.length} guardada${data.copias.length === 1 ? "" : "s"}).`
    : "Ainda não há cópia automática guardada.";
}

$("#backup-baixar").addEventListener("click", async (ev) => {
  const botao = ev.currentTarget;
  const status = $("#backup-status");
  botao.disabled = true;
  status.textContent = "Gerando a cópia…";
  const { data, error } = await sb.functions.invoke("backup", { body: { acao: "baixar" } });
  botao.disabled = false;
  if (error || !data?.tabelas) { status.textContent = "Não foi possível gerar o backup. Tente de novo."; return; }

  const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: `grc-plus-backup-${data.gerado_em.slice(0, 10)}.json` });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  const c = data.contagem;
  status.textContent = `Baixado: ${c.contatos} contatos, ${c.conversas} conversas, ${c.atendimentos} atendimentos e ${c.mensagens} mensagens.`;
});

// ---------------------------------------------------------------------------
// Usuários e permissões (Ajustes). Só o usuário mestre cria, edita, inativa e exclui.
// ---------------------------------------------------------------------------
const PERMISSOES = [
  ["funil", "Ver o Funil"],
  ["conversas", "Ver a lista de Conversas"],
  ["mensagens", "Abrir conversas e ler as mensagens"],
  ["contatos", "Ver Contatos"],
  ["editar_contatos", "Editar etiquetas e anotações dos contatos"],
  ["clientes", "Ver Clientes (quem fechou frete)"],
  ["editar_clientes", "Cadastrar, alterar e excluir clientes"],
  ["painel", "Ver o Painel"],
];
let usuarioEmEdicao = null; // null = criando um novo

// O mestre pode tudo; os demais, só o que estiver marcado. (O banco aplica a mesma regra.)
function pode(permissao) {
  return perfil?.papel === "mestre" || perfil?.permissoes?.[permissao] === true;
}

// Chama uma Edge Function e devolve { data, erro } com a mensagem de erro em português
async function chamarFuncao(nome, corpo) {
  const { data, error } = await sb.functions.invoke(nome, { body: corpo });
  if (!error) return { data, erro: null };
  let erro = "Não foi possível concluir. Tente de novo.";
  try { erro = (await error.context.json()).erro ?? erro; } catch { /* resposta sem corpo */ }
  return { data: null, erro };
}

function desenharCaixasDePermissao() {
  const caixa = $("#usuario-permissoes");
  if (caixa.children.length) return;
  for (const [chave, rotulo] of PERMISSOES) {
    const linha = el("label", "marcar");
    const campo = Object.assign(document.createElement("input"), { type: "checkbox", name: `perm_${chave}`, defaultChecked: true });
    linha.append(campo, el("span", "", rotulo));
    caixa.append(linha);
  }
}

function atualizarCaixasConformePapel() {
  const form = $("#form-usuario");
  const mestre = form.papel.value === "mestre";
  $("#usuario-permissoes-nota").textContent = mestre
    ? "Usuário mestre tem acesso a tudo e pode gerenciar usuários."
    : "Marque o que este usuário pode fazer.";
  $$("#usuario-permissoes input").forEach((c) => { c.disabled = mestre; });
}

function abrirFormUsuario(u) {
  desenharCaixasDePermissao();
  const form = $("#form-usuario");
  form.reset();
  usuarioEmEdicao = u?.id ?? null;
  $("#usuario-form-titulo").textContent = u ? `Editar ${u.nome || u.email}` : "Novo usuário";
  $("button[type=submit]", form).textContent = u ? "Salvar alterações" : "Criar usuário";
  form.email.disabled = !!u;
  $("#usuario-campo-senha").hidden = !!u;
  if (u) {
    form.nome.value = u.nome ?? "";
    form.email.value = u.email ?? "";
    form.papel.value = u.papel;
    for (const [chave] of PERMISSOES) form[`perm_${chave}`].checked = u.permissoes?.[chave] === true;
  }
  form.papel.disabled = u?.id === perfil.id; // ninguém rebaixa a si mesmo
  atualizarCaixasConformePapel();
  $(".aviso", form).hidden = true;
  $("#usuario-form-caixa").hidden = false;
  $("#usuario-novo").hidden = true;
  form.nome.focus();
}

function fecharFormUsuario() {
  usuarioEmEdicao = null;
  $("#usuario-form-caixa").hidden = true;
  $("#usuario-novo").hidden = perfil?.papel !== "mestre";
}

$("#usuario-novo").addEventListener("click", () => abrirFormUsuario(null));
$("#usuario-cancelar").addEventListener("click", fecharFormUsuario);
$("#form-usuario").papel.addEventListener("change", atualizarCaixasConformePapel);

$("#form-usuario").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const form = ev.currentTarget;
  const nome = form.nome.value.trim();
  const papel = form.papel.value === "mestre" ? "mestre" : "usuario";
  const permissoes = Object.fromEntries(PERMISSOES.map(([chave]) => [chave, papel === "mestre" || form[`perm_${chave}`].checked]));
  if (!nome) return avisar(form, "Informe o nome.");

  comBotaoOcupado(form, async () => {
    if (usuarioEmEdicao) {
      const mudanca = usuarioEmEdicao === perfil.id ? { nome } : { nome, papel, permissoes };
      const { error } = await sb.from("usuarios").update(mudanca).eq("id", usuarioEmEdicao);
      if (error) return avisar(form, traduzirErro(error));
      if (usuarioEmEdicao === perfil.id) { perfil.nome = nome; $("#usuario-nome").textContent = nome; $("#usuario-avatar").textContent = iniciais(nome); }
    } else {
      const email = form.email.value.trim();
      const senha = form.senha.value;
      if (!email) return avisar(form, "Informe o e-mail.");
      if (senha.length < 8) return avisar(form, "A senha precisa ter pelo menos 8 caracteres.");
      const { data: criado, erro } = await chamarFuncao("usuarios", { acao: "criar", nome, email, senha, papel, permissoes });
      if (erro) return avisar(form, erro);
      // Garante todas as permissões marcadas, inclusive as criadas depois da função de usuários
      if (criado?.id) await sb.from("usuarios").update({ permissoes }).eq("id", criado.id);
    }
    fecharFormUsuario();
    await carregarUsuarios();
  });
});

// Excluir pede um segundo clique para confirmar
function botaoExcluir(usuario) {
  const botao = el("button", "botao perigo", "Excluir");
  botao.type = "button";
  let confirmando = null;
  botao.addEventListener("click", async () => {
    if (!confirmando) {
      botao.textContent = "Confirmar exclusão";
      confirmando = setTimeout(() => { confirmando = null; botao.textContent = "Excluir"; }, 5000);
      return;
    }
    clearTimeout(confirmando);
    botao.disabled = true;
    botao.textContent = "Excluindo…";
    const { erro } = await chamarFuncao("usuarios", { acao: "excluir", id: usuario.id });
    if (usuarioEmEdicao === usuario.id) fecharFormUsuario();
    await carregarUsuarios();
    if (erro) $("#ajustes-aviso").textContent = erro;
  });
  return botao;
}

async function carregarUsuarios() {
  carregarBackups();
  const mestre = perfil.papel === "mestre";
  $("#ajustes-aviso").textContent = mestre
    ? "Crie os usuários da equipe e defina o que cada um pode fazer."
    : "Somente usuários mestres gerenciam a equipe. Abaixo está o seu usuário.";
  if ($("#usuario-form-caixa").hidden) $("#usuario-novo").hidden = !mestre;

  const { data, error } = await sb.from("usuarios").select("*").order("criado_em");
  const corpo = $("#tabela-usuarios tbody");
  corpo.replaceChildren();
  if (error) return ($("#ajustes-aviso").textContent = traduzirErro(error));

  for (const u of data) {
    const marcadas = PERMISSOES.filter(([chave]) => u.permissoes?.[chave] === true).length;
    const resumo = u.papel === "mestre" ? "Acesso total" : marcadas === 0 ? "Nenhuma" : `${marcadas} de ${PERMISSOES.length}`;
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

    if (mestre) {
      const editar = el("button", "botao", "Editar");
      editar.type = "button";
      editar.addEventListener("click", () => abrirFormUsuario(u));
      acoes.append(editar);
      if (u.id !== perfil.id) {
        acoes.append(botaoUsuario(u.ativo ? "Inativar" : "Reativar", u, { ativo: !u.ativo }), botaoExcluir(u));
      }
    }

    linha.append(
      celula(u.nome || "(sem nome)"), celula(u.email),
      etiqueta(u.papel === "mestre" ? "Mestre" : "Usuário", u.papel === "mestre" ? "var(--ciano)" : "var(--neutro)"),
      etiqueta(u.ativo ? "Ativo" : "Inativo", u.ativo ? "var(--verde)" : "var(--dourado)"),
      celula(resumo),
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
    await carregarUsuarios();
    if (error) $("#ajustes-aviso").textContent = traduzirErro(error);
  });
  return botao;
}

// ---------------------------------------------------------------------------
// Ajuda: perguntas com passo a passo. Cada pessoa vê só o que o seu usuário pode fazer.
// "requer" é uma permissão (ou "mestre"); "pagina" cria o botão que leva direto à tela.
// Nos textos, **assim** vira negrito.
// ---------------------------------------------------------------------------
const AJUDA = [
  { grupo: "Atendimento" },
  { pergunta: "Como ver quem está esperando um atendente?", requer: "funil", pagina: "funil", passos: [
    "Abra **Funil** no menu.",
    "Olhe a coluna **Aguardando humano**: cada cartão é um cliente que pediu atendimento e ainda não foi assumido.",
    "O cartão mostra **Esperando há X min**. Quem espera há mais tempo fica no topo.",
    "O número em **Aguardando humano**, no alto da tela, mostra quantos estão na fila agora.",
  ], dica: "A tela se atualiza sozinha. O selo \"Ao vivo\", no topo, indica que a conexão está ativa." },
  { pergunta: "Como abrir e ler uma conversa?", requer: "mensagens", pagina: "conversas", passos: [
    "No **Funil**, clique no cartão do cliente. A conversa abre na lateral.",
    "Ou abra **Conversas** no menu e clique no nome do cliente na lista da esquerda.",
    "As mensagens do cliente ficam à esquerda; as do bot e da equipe, à direita.",
    "Para fechar, clique no **X** ou fora da conversa.",
  ] },
  { pergunta: "Como responder um cliente?", passos: [
    "O GRC + é só para acompanhar: ele **não envia mensagens**.",
    "Para responder, abra o **GPT Maker** e assuma o atendimento por lá.",
    "Assim que você responder, a mensagem aparece aqui no GRC + sozinha.",
  ] },
  { pergunta: "Como procurar um cliente ou filtrar por data?", requer: "funil", pagina: "funil", passos: [
    "No topo da tela, digite o nome ou o número em **Buscar contato ou número**.",
    "Para filtrar por data, clique em **Todo o período** e escolha Hoje, Ontem, Últimos 7 dias ou Últimos 30 dias.",
    "Para um intervalo específico, escolha **Escolher datas…** e informe a data inicial e a final.",
    "Para voltar a ver tudo, selecione **Todo o período** e apague a busca.",
  ], dica: "A data considerada é a da última mensagem da conversa. A busca e o filtro valem no Funil e em Conversas." },
  { pergunta: "O que significa cada coluna do Funil?", requer: "funil", pagina: "funil", passos: [
    "**Leads convertidos**: conversa finalizada de um cliente que a equipe já cadastrou em Clientes.",
    "**Bot atendendo**: o robô está conversando com o cliente.",
    "**Aguardando humano**: o cliente pediu um atendente e ninguém assumiu ainda.",
    "**Humano atendendo**: alguém da equipe assumiu a conversa no GPT Maker.",
    "**Finalizado**: atendimento encerrado, de quem ainda não é cliente cadastrado.",
  ] },

  { grupo: "Clientes" },
  { pergunta: "Como cadastrar novos clientes?", requer: "editar_clientes", pagina: "clientes", passos: [
    "Abra **Clientes** no menu.",
    "Clique em **+ Novo cliente**.",
    "Preencha o **nome ou razão social** (obrigatório), o CNPJ, o endereço, a pessoa de contato, o telefone e o e-mail.",
    "Clique em **Salvar cliente**.",
  ], dica: "Atalho: abra a conversa do cliente e clique em \"Cadastrar como cliente\". O cadastro já vem com a pessoa de contato e o telefone preenchidos." },
  { pergunta: "Como fazer um lead aparecer em \"Leads convertidos\"?", requer: "editar_clientes", pagina: "funil", passos: [
    "Finalize o atendimento no **GPT Maker**. A conversa vai para a coluna **Finalizado**.",
    "No Funil, clique no cartão do cliente para abrir a conversa.",
    "Clique em **Cadastrar como cliente**, no rodapé da conversa.",
    "Complete os dados e clique em **Salvar cliente**.",
    "Pronto: a conversa passa sozinha para **Leads convertidos**.",
  ], dica: "Se cadastrar pela guia Clientes, use o mesmo telefone do WhatsApp para o sistema ligar o cliente à conversa." },
  { pergunta: "Como alterar ou excluir um cliente?", requer: "editar_clientes", pagina: "clientes", passos: [
    "Abra **Clientes** e clique no cliente na lista.",
    "Para alterar, mude os campos e clique em **Salvar cliente**.",
    "Para excluir, clique em **Excluir cliente** e depois em **Confirmar exclusão**.",
  ], dica: "Ao excluir um cliente, a conversa dele volta da coluna Leads convertidos para Finalizado." },
  { pergunta: "Como procurar um cliente cadastrado?", requer: "clientes", pagina: "clientes", passos: [
    "Abra **Clientes** no menu.",
    "Digite no campo de busca do topo: vale nome, CNPJ, pessoa de contato, endereço ou telefone.",
    "Clique no cliente para ver todos os dados.",
  ] },

  { grupo: "Contatos do WhatsApp" },
  { pergunta: "Como ver o histórico de um contato?", requer: "contatos", pagina: "contatos", passos: [
    "Abra **Contatos** no menu e clique no nome da pessoa.",
    "No alto da ficha aparecem o primeiro contato, o total de atendimentos e a última mensagem.",
    "Em **Linha do tempo** estão todos os atendimentos, com protocolo, data, duração e quem atendeu.",
    "Clique em **Ver conversa** para ler as mensagens.",
  ] },
  { pergunta: "Como colocar etiquetas e anotações em um contato?", requer: "editar_contatos", pagina: "contatos", passos: [
    "Abra **Contatos** e clique no nome da pessoa.",
    "Em **Etiquetas**, digite o texto (por exemplo, Orçamento) e clique em **Adicionar**. Para remover, clique no **×** da etiqueta.",
    "Em **Anotações internas**, escreva o que quiser e clique em **Salvar anotações**.",
  ], dica: "Etiquetas e anotações ficam só no GRC +. O cliente não vê e elas não vão para o GPT Maker." },

  { grupo: "Indicadores" },
  { pergunta: "Como ver os números do atendimento?", requer: "painel", pagina: "painel", passos: [
    "Abra **Painel** no menu.",
    "Escolha o período: **7 dias**, **30 dias** ou **90 dias**.",
    "Os cartões mostram atendimentos, novos contatos, transferências para humano, espera média e duração média.",
    "Passe o mouse sobre uma barra dos gráficos para ver o valor exato do dia ou do horário.",
  ] },

  { grupo: "Usuários e administração" },
  { pergunta: "Como criar um novo usuário?", requer: "mestre", pagina: "ajustes", passos: [
    "Abra **Ajustes** no menu.",
    "Clique em **+ Novo usuário**.",
    "Preencha nome, e-mail e uma **senha inicial** com pelo menos 8 caracteres.",
    "Escolha o papel e marque **o que este usuário pode fazer**.",
    "Clique em **Criar usuário** e passe o e-mail e a senha para a pessoa.",
  ], dica: "O usuário já nasce ativo. Ele pode trocar a senha depois usando \"Esqueci minha senha\" na tela de login." },
  { pergunta: "Como mudar o que um usuário pode fazer?", requer: "mestre", pagina: "ajustes", passos: [
    "Abra **Ajustes** e clique em **Editar** na linha do usuário.",
    "Marque ou desmarque as permissões.",
    "Clique em **Salvar alterações**.",
  ], dica: "A pessoa precisa recarregar a página para o menu dela se atualizar." },
  { pergunta: "Como inativar ou excluir um usuário?", requer: "mestre", pagina: "ajustes", passos: [
    "Abra **Ajustes**.",
    "Para tirar o acesso sem apagar, clique em **Inativar**. Para devolver, clique em **Reativar**.",
    "Para apagar de vez, clique em **Excluir** e depois em **Confirmar exclusão**.",
  ], dica: "O sistema não deixa ficar sem nenhum usuário mestre ativo, e ninguém consegue excluir o próprio usuário." },
  { pergunta: "Como baixar um backup dos dados?", requer: "mestre", pagina: "ajustes", passos: [
    "Abra **Ajustes** e desça até **Backup dos dados**.",
    "Clique em **Baixar backup agora**.",
    "O arquivo é salvo na pasta de downloads do seu computador.",
  ], dica: "Além disso, todo domingo o sistema guarda uma cópia automática e mantém as 8 mais recentes." },

  { grupo: "Acesso" },
  { pergunta: "Esqueci minha senha. O que faço?", passos: [
    "Na tela de login, clique em **Esqueci minha senha**.",
    "Informe o seu e-mail e clique em **Enviar link**.",
    "Abra o e-mail recebido (confira o spam) e clique no link.",
    "Digite a nova senha duas vezes e clique em **Salvar nova senha**.",
  ] },
  { pergunta: "Por que não vejo algum item do menu?", passos: [
    "O menu mostra só o que o seu usuário tem permissão para ver.",
    "Se precisar de acesso a outra tela, peça a um **usuário mestre**.",
    "Depois que ele liberar, recarregue a página.",
  ] },
  { pergunta: "Como sair do sistema?", passos: [
    "Clique no ícone de **sair**, ao lado do seu nome, no canto inferior esquerdo (no celular, no canto superior direito).",
  ] },
];

function podeVerAjuda(t) {
  if (!t.requer) return true;
  return t.requer === "mestre" ? perfil?.papel === "mestre" : pode(t.requer);
}

// Texto com **negrito**, montado sem HTML solto
function textoComNegrito(alvo, texto) {
  texto.split("**").forEach((parte, i) => { if (parte) alvo.append(i % 2 ? el("b", "", parte) : parte); });
  return alvo;
}

function desenharAjuda() {
  const termo = $("#ajuda-filtro").value.trim().toLowerCase();
  const lista = $("#ajuda-lista");
  lista.replaceChildren();
  let grupoPendente = null;
  let total = 0;

  for (const t of AJUDA) {
    if (t.grupo) { grupoPendente = t.grupo; continue; }
    if (!podeVerAjuda(t)) continue;
    if (termo && !(t.pergunta + " " + t.passos.join(" ") + " " + (t.dica ?? "")).toLowerCase().includes(termo)) continue;
    if (grupoPendente) { lista.append(el("p", "grupo", grupoPendente)); grupoPendente = null; }

    const topico = el("details", "topico");
    topico.append(el("summary", "", t.pergunta));
    const corpo = el("div", "corpo");
    const passos = el("ol");
    for (const p of t.passos) {
      const passo = el("li");
      passo.append(textoComNegrito(el("span"), p));
      passos.append(passo);
    }
    corpo.append(passos);
    if (t.dica) corpo.append(el("p", "dica", t.dica));
    if (t.pagina && (t.pagina === "ajustes" || pode(t.pagina))) {
      const ir = el("button", "botao", `Ir para ${PAGINAS[t.pagina][0]}`);
      ir.type = "button";
      ir.addEventListener("click", () => { fecharAjuda(); abrirPagina(t.pagina); });
      corpo.append(ir);
    }
    topico.append(corpo);
    // Abre um por vez, para a lista não ficar comprida
    topico.addEventListener("toggle", () => {
      if (topico.open) $$(".topico[open]", lista).forEach((o) => { if (o !== topico) o.open = false; });
    });
    if (termo) topico.open = total === 0;
    lista.append(topico);
    total++;
  }
  if (!total) lista.append(el("p", "vazio", "Nenhuma pergunta encontrada. Tente outra palavra."));
}

function abrirAjuda() {
  $("#ajuda-filtro").value = "";
  desenharAjuda();
  $("#ajuda").hidden = $("#ajuda-fundo").hidden = false;
  $("#ajuda-fechar").focus();
}
function fecharAjuda() {
  if ($("#ajuda").hidden) return;
  $("#ajuda").hidden = $("#ajuda-fundo").hidden = true;
  $("#ajuda-abrir").focus();
}
$("#ajuda-abrir").addEventListener("click", abrirAjuda);
$("#ajuda-fechar").addEventListener("click", fecharAjuda);
$("#ajuda-fundo").addEventListener("click", fecharAjuda);
$("#ajuda-filtro").addEventListener("input", desenharAjuda);
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") fecharAjuda(); });

// ---------------------------------------------------------------------------
// Início
// ---------------------------------------------------------------------------
sb.auth.onAuthStateChange((evento) => {
  if (evento === "SIGNED_OUT") { perfil = null; emRecuperacao = false; pararTempoReal(); mostrarTela("login"); }
  if (evento === "PASSWORD_RECOVERY") { emRecuperacao = true; pararTempoReal(); mostrarTela("nova-senha"); }
});

rotear().catch(() => mostrarTela("login"));

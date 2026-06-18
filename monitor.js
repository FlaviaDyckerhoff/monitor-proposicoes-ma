const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CASA = 'ALEMA';
const BASE = 'https://sapl.al.ma.leg.br/sapl/consultas/materia/materia_mostrar_proc?cod_materia=';
const ARQUIVO_ESTADO = 'estado.json';
const JANELA_SCAN = Number(process.env.JANELA_SCAN || 100);
const START_FALLBACK = Number(process.env.START_FALLBACK || 62000);
const CONCORRENCIA = Number(process.env.CONCORRENCIA || 8);
const MAX_NETWORK_ERRORS_ZERO_RESULT = Number(process.env.MAX_NETWORK_ERRORS_ZERO_RESULT || 20);

function carregarEstado() {
  if (fs.existsSync(ARQUIVO_ESTADO)) return JSON.parse(fs.readFileSync(ARQUIVO_ESTADO, 'utf8'));
  return { ultimo_id_visto: 0, proposicoes_vistas: [], ultimos_por_tipo_ano: {}, ultima_execucao: '' };
}

function salvarEstado(estado) {
  fs.writeFileSync(ARQUIVO_ESTADO, JSON.stringify(estado, null, 2));
}

function decode(texto) {
  return String(texto || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&uacute;/g, 'ú')
    .replace(/&ccedil;/g, 'ç')
    .replace(/&atilde;/g, 'ã')
    .replace(/&otilde;/g, 'õ')
    .replace(/&aacute;/g, 'á')
    .replace(/&eacute;/g, 'é')
    .replace(/&iacute;/g, 'í')
    .replace(/&oacute;/g, 'ó')
    .replace(/&Aacute;/g, 'Á')
    .replace(/&Eacute;/g, 'É')
    .replace(/&Ccedil;/g, 'Ç')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function limparHtml(texto) {
  return decode(String(texto || '').replace(/<[^>]+>/g, ' '));
}

function escapeHtml(texto) {
  return String(texto ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function numeroInteiro(p) {
  const n = Number(String(p.numero || '').replace(/\D/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function chaveTipoAno(p) {
  return `${p.tipo || 'OUTROS'}|${p.ano || '-'}`;
}

function calcularUltimosPorTipoAno(proposicoes) {
  const ultimos = {};
  for (const p of proposicoes) {
    const numero = numeroInteiro(p);
    if (!numero || !p.ano || p.ano === '-') continue;
    const chave = chaveTipoAno(p);
    ultimos[chave] = Math.max(ultimos[chave] || 0, numero);
  }
  return ultimos;
}

function detectarSaltos(proposicoes, estado) {
  const anteriores = estado.ultimos_por_tipo_ano || {};
  const atuais = calcularUltimosPorTipoAno(proposicoes);
  const presentes = {};
  for (const p of proposicoes) {
    const numero = numeroInteiro(p);
    if (!numero) continue;
    const chave = chaveTipoAno(p);
    if (!presentes[chave]) presentes[chave] = new Set();
    presentes[chave].add(numero);
  }
  const alertas = [];
  for (const [chave, atual] of Object.entries(atuais)) {
    const anterior = Number(anteriores[chave] || 0);
    if (!anterior || atual <= anterior + 1) continue;
    const faltantes = [];
    for (let n = anterior + 1; n < atual; n++) {
      if (!presentes[chave]?.has(n)) faltantes.push(n);
    }
    if (faltantes.length) {
      const [tipo, ano] = chave.split('|');
      alertas.push({ tipo, ano, anterior, atual, faltantes });
    }
  }
  return { alertas, atuais };
}

function renderAlertasSaltos(alertas) {
  if (!alertas.length) return '';
  const itens = alertas.map(a => `<li><strong>${escapeHtml(a.tipo)} ${escapeHtml(a.ano)}</strong>: último visto ${a.anterior}, maior atual ${a.atual}. Possível(is) ausente(s): ${escapeHtml(a.faltantes.join(', '))}</li>`).join('');
  return `<div style="background:#fff4e5;border:1px solid #f59e0b;color:#7c2d12;padding:12px 14px;margin:12px 0;border-radius:4px"><strong>Alerta de sequência:</strong><ul style="margin:8px 0 0 18px;padding:0">${itens}</ul></div>`;
}

async function buscarMateria(id) {
  const url = BASE + id;
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/120', 'Accept': 'text/html' }, signal: AbortSignal.timeout(8000) });
  } catch (err) {
    console.log(`Erro de rede no ID ${id}: ${err.message}`);
    return { erroRede: true, id, message: err.message };
  }
  if (!res.ok) return false;
  const buffer = Buffer.from(await res.arrayBuffer());
  const html = buffer.toString('latin1');
  if (!html.includes('Identifica') || !html.includes('Ementa')) return false;
  const texto = limparHtml(html);
  const tipo = (texto.match(/Tipo:\s*(.*?)\s+Número:/i) || [])[1] || 'OUTROS';
  const numeroAno = (texto.match(/Número:\s*([^\s]+)\s+Data:/i) || [])[1] || '-/-';
  const data = (texto.match(/Data:\s*(\d{2}\/\d{2}\/\d{4})/i) || [])[1] || '-';
  const ementa = (texto.match(/Ementa:\s*(.*?)(?:Texto Original|Autor|Tramitação|$)/i) || [])[1] || '-';
  const [numero, ano] = numeroAno.split('/');
  return {
    id: String(id),
    tipo: decode(tipo),
    numero: numero || '-',
    ano: ano || '-',
    data,
    autor: '-',
    ementa: decode(ementa).replace(/\s+/g, ' ').trim() || '-',
    link: url,
  };
}

async function buscarProposicoes(estado) {
  const inicio = Math.max(Number(estado.ultimo_id_visto || 0) + 1, START_FALLBACK);
  const fim = inicio + JANELA_SCAN;
  const novas = [];
  let errosRede = 0;
  let maiorExistente = Number(estado.ultimo_id_visto || 0);
  let vaziosConsecutivos = 0;
  for (let base = inicio; base <= fim; base += CONCORRENCIA) {
    const ids = Array.from({ length: Math.min(CONCORRENCIA, fim - base + 1) }, (_, i) => base + i);
    const resultados = await Promise.all(ids.map(id => buscarMateria(id).then(item => ({ id, item }))));
    for (const { id, item } of resultados) {
      if (item && item.erroRede) {
        errosRede++;
      } else if (item) {
        maiorExistente = Math.max(maiorExistente, id);
        vaziosConsecutivos = 0;
        novas.push(item);
        console.log(`OK ${id}: ${item.tipo} ${item.numero}/${item.ano}`);
      } else if (item === false) {
        vaziosConsecutivos++;
      }
    }
    if (vaziosConsecutivos >= 30 && novas.length > 0) break;
  }
  return { proposicoes: novas, maiorExistente, errosRede };
}

function prioridadeTipoEmail(tipo) {
  const t = String(tipo || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .trim();

  if (/^(PL|PLO)(\b|$)/.test(t) || /^PROJETO DE LEI( ORDINARIA)?$/.test(t)) return 0;
  if (/^PLC(\b|$)/.test(t) || /^PROJETO DE LEI COMPLEMENTAR/.test(t)) return 1;
  if (/^PEC(\b|$)/.test(t) || /^(PROPOSTA|PROJETO) DE EMENDA (A )?CONSTITUCIONAL/.test(t)) return 2;
  return 10;
}

function numeroProposicaoEmail(p) {
  const n = Number(String(p?.numero || '').replace(/\D/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function compararProposicoesEmail(a, b) {
  const tipoA = a?.sigla || a?.tipo || '';
  const tipoB = b?.sigla || b?.tipo || '';
  const prioridadeA = prioridadeTipoEmail(tipoA);
  const prioridadeB = prioridadeTipoEmail(tipoB);
  if (prioridadeA !== prioridadeB) return prioridadeA - prioridadeB;
  const tipoCmp = String(tipoA).localeCompare(String(tipoB), 'pt-BR');
  if (tipoCmp !== 0) return tipoCmp;
  return numeroProposicaoEmail(b) - numeroProposicaoEmail(a);
}


const CLIENTES_NOMES_PROPRIOS = [
  'FIRJAN', 'Red Bull', 'Sindicerv', 'Boticario', 'Boticário', 'Abrasel', 'ANBRASEL',
  'Energisa', 'EnergisaLuz', 'SABESP', 'COMGAS', 'COMGÁS', 'Eletromidia', 'Eletromídia',
  'BRT', 'Regenera', 'Nova Infra', 'Seta', 'SETA', 'AkzoNobel', 'Expedia', 'RTSC',
  'Huawei', 'Carrefour', 'JBS', 'Ajinomoto', 'Vibra', 'Mindlab', 'ABVTEX', 'Neoenergia', 'ENEL'
];

function clientesCitadosNaProposicao(p) {
  const texto = [p.cliente, p.clientes, p.autor, p.autores, p.tipo, p.rotulo, p.titulo, p.identificacao, p.ementa]
    .filter(Boolean)
    .join(' ');
  const achados = [];
  for (const nome of CLIENTES_NOMES_PROPRIOS) {
    const escaped = nome.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(^|[^A-Za-zÀ-ÿ0-9])' + escaped + '([^A-Za-zÀ-ÿ0-9]|$)', 'i');
    if (re.test(texto) && !achados.some(a => a.toLowerCase() === nome.toLowerCase())) achados.push(nome);
  }
  return achados;
}

function anotarClientesCitados(proposicoes) {
  for (const p of proposicoes || []) {
    const clientes = clientesCitadosNaProposicao(p);
    p.clientesCitados = clientes;
    if (clientes.length && p.ementa && !String(p.ementa).includes('Cliente citado:')) {
      p.ementa = String(p.ementa).trim() + ' | Cliente citado: ' + clientes.join(', ');
    }
  }
}

function mlEscapeHtmlClienteDestaque(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function mlEscapeRegExpClienteDestaque(valor) {
  return String(valor).replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
}

function mlDestacarTermosClienteEmail(texto, clientes) {
  const nomes = Array.from(new Set([...(clientes || []), ...CLIENTES_NOMES_PROPRIOS]))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (!nomes.length) return mlEscapeHtmlClienteDestaque(texto);

  const regex = new RegExp('(^|[^A-Za-zÀ-ÿ0-9])(' + nomes.map(mlEscapeRegExpClienteDestaque).join('|') + ')(?=[^A-Za-zÀ-ÿ0-9]|$)', 'gi');
  return mlEscapeHtmlClienteDestaque(texto).replace(regex, (match, prefixo, termo) => {
    return prefixo + '<span style="background:#dbeafe;color:#1e3a8a;font-weight:700;border-radius:3px;padding:1px 3px">' + termo + '</span>';
  });
}

function renderizarEmentaCliente(p, renderBase) {
  const texto = String((p && p.ementa) || '-');
  const partes = texto.split(/\s+\|\s+Cliente citado:\s+/i);
  const ementa = renderBase
    ? renderBase(partes[0])
    : mlDestacarTermosClienteEmail(partes[0], p && p.clientesCitados);
  const clientes = partes.length > 1
    ? partes.slice(1).join(' | Cliente citado: ')
    : ((p && p.clientesCitados) || []).join(', ');

  if (!clientes) return ementa;
  return ementa + '<div style="margin-top:6px">' +
    '<span style="display:inline-block;background:#eef6ff;border:1px solid #bfdbfe;color:#1e3a8a;border-radius:999px;padding:3px 8px;font-size:11px;font-weight:700">' +
    'Cliente citado: ' + mlDestacarTermosClienteEmail(clientes, p && p.clientesCitados) +
    '</span></div>';
}

async function enviarEmail(novas, alertas = []) {
  anotarClientesCitados(novas);
  if (process.env.DRY_RUN_EMAIL === '1') {
    console.log(`[DRY_RUN_EMAIL] ${novas.length} proposições novas.`);
    novas.slice(0, 10).forEach(p => console.log(`${p.id} ${p.tipo} ${p.numero}/${p.ano} - ${p.data}`));
    alertas.forEach(a => console.log(`[ALERTA_SEQUENCIA] ${a.tipo}/${a.ano}: ${a.anterior} -> ${a.atual}; faltantes: ${a.faltantes.join(', ')}`));
    return;
  }
  const novasOrdenadas = [...novas].sort(compararProposicoesEmail);
  const linhas = novasOrdenadas.map(p => `<tr><td style="padding:8px;border-bottom:1px solid #eee"><a href="${escapeHtml(p.link)}"><strong>${escapeHtml(p.tipo)} ${escapeHtml(p.numero)}/${escapeHtml(p.ano)}</strong></a></td><td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(p.data)}</td><td style="padding:8px;border-bottom:1px solid #eee">${renderizarEmentaCliente(p)}</td></tr>`).join('');
  const subject = `🏛️ ${CASA}: ${novas.length} nova(s) proposição(ões)${alertas.length ? ' | alerta sequência' : ''} — ${new Date().toLocaleDateString('pt-BR')}`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:960px"><h2>${CASA} — ${novas.length} nova(s) proposição(ões)</h2>${renderAlertasSaltos(alertas)}<table style="border-collapse:collapse;width:100%">${linhas}</table></div>`;

  if (process.env.USE_GMAIL_API === '1') {
    const tmp = path.join(os.tmpdir(), 'alema-email-' + Date.now() + '.html');
    fs.writeFileSync(tmp, html);
    const script = [
      'import sys',
      "sys.path.insert(0, '/root/.openclaw/workspace/agents/shared')",
      'from notificacoes import enviar_email',
      'subject = sys.argv[1]',
      'html_path = sys.argv[2]',
      'destinos = [d.strip() for d in sys.argv[3].split(\",\") if d.strip()]',
      "body = open(html_path, encoding='utf-8').read()",
      'ok = enviar_email(subject, body, destinatarios=destinos)',
      'raise SystemExit(0 if ok else 1)',
    ].join('\n');
    const result = spawnSync('python3', ['-c', script, subject, tmp, process.env.EMAIL_DESTINO || 'tramitacao@monitorlegislativo.com.br'], { encoding: 'utf8' });
    fs.rmSync(tmp, { force: true });
    if (result.status !== 0) {
      throw new Error('Falha no envio via Gmail API: ' + (result.stderr || result.stdout || 'sem detalhe'));
    }
    console.log(`Email enviado via Gmail API com ${novas.length} proposição(ões) nova(s). destino=${process.env.EMAIL_DESTINO || 'tramitacao@monitorlegislativo.com.br'}`);
    return;
  }

  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.EMAIL_REMETENTE, pass: process.env.EMAIL_SENHA } });
  const info = await transporter.sendMail({
    from: `"Monitor ${CASA}" <${process.env.EMAIL_REMETENTE}>`,
    to: process.env.EMAIL_DESTINO,
    subject,
    html,
  });
  console.log(`Email enviado com ${novas.length} proposição(ões) nova(s). messageId=${info.messageId || '-'} destino=${process.env.EMAIL_DESTINO || '-'}`);
}

(async () => {
  console.log('Iniciando Monitor Proposições MA...');
  const estado = carregarEstado();
  const ids = new Set((estado.proposicoes_vistas || []).map(String));
  const { proposicoes, maiorExistente, errosRede } = await buscarProposicoes(estado);
  const novas = proposicoes.filter(p => !ids.has(p.id));
  const { alertas, atuais } = detectarSaltos(proposicoes, estado);
  console.log(`Encontradas: ${proposicoes.length} | Novas: ${novas.length} | maior ID: ${maiorExistente} | erros de rede: ${errosRede}`);
  if (proposicoes.length === 0 && errosRede >= MAX_NETWORK_ERRORS_ZERO_RESULT) {
    throw new Error(`Coleta inválida: ${errosRede} erros de rede e 0 proposições encontradas. Run não pode ficar verde.`);
  }
  if (process.env.DRY_RUN_EMAIL === '1') {
    await enviarEmail(novas, alertas);
    console.log('DRY_RUN_EMAIL=1 — estado preservado sem alterações.');
    return;
  }
  if (process.env.SEED_ONLY === '1') {
    proposicoes.forEach(p => ids.add(p.id));
    estado.proposicoes_vistas = Array.from(ids);
    estado.ultimo_id_visto = Math.max(Number(estado.ultimo_id_visto || 0), maiorExistente);
    estado.ultimos_por_tipo_ano = { ...(estado.ultimos_por_tipo_ano || {}), ...atuais };
    estado.ultima_execucao = new Date().toISOString();
    salvarEstado(estado);
    console.log('SEED_ONLY=1 — estado semeado sem envio.');
    return;
  }
  if (novas.length || alertas.length) {
    await enviarEmail(novas, alertas);
    novas.forEach(p => ids.add(p.id));
    estado.proposicoes_vistas = Array.from(ids);
  }
  estado.ultimo_id_visto = Math.max(Number(estado.ultimo_id_visto || 0), maiorExistente);
  estado.ultimos_por_tipo_ano = { ...(estado.ultimos_por_tipo_ano || {}), ...atuais };
  estado.ultima_execucao = new Date().toISOString();
  salvarEstado(estado);
})();

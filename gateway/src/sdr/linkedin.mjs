// URLs de perfiles de LinkedIn en una sola forma: https://www.linkedin.com/in/<slug>.
//
// El equipo de headhunting ya pagó dos errores con esto (docs/12, Dripify §8): URLs con host
// de país (ar., mx.) que no actualizan al lead existente, y un slug truncado que se fusionó con
// otra persona. Por eso se normaliza siempre y se rechaza lo dudoso en vez de adivinar.

import { errors } from '../errors.mjs';

export function normalizeLinkedin(raw) {
  const original = String(raw ?? '').trim();
  if (!original) return null;
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(original) ? original : `https://${original}`);
  } catch {
    throw errors.invalid(`URL de LinkedIn inválida: "${original}".`);
  }
  const host = url.hostname.toLowerCase();
  if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) {
    throw errors.invalid(`No es una URL de LinkedIn: "${original}".`);
  }
  const m = /^\/in\/([^/]+)\/?$/.exec(url.pathname);
  if (!m) throw errors.invalid(`La URL de LinkedIn tiene que ser de un perfil (/in/…): "${original}".`);
  let slug;
  try { slug = decodeURIComponent(m[1]).toLowerCase(); } catch { slug = m[1].toLowerCase(); }
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_-]{1,99}$/u.test(slug) || slug.endsWith('-')) {
    throw errors.invalid(`El perfil de LinkedIn parece cortado o inválido: "${original}". Verificar la URL completa.`);
  }
  return `https://www.linkedin.com/in/${slug}`;
}

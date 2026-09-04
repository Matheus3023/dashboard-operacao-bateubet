/**
 * Sai da sessão do painel: apaga o cookie e manda pra tela de login.
 * GET /api/auth/logout
 */
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Set-Cookie', 'bateu_sessao=; Path=/; Max-Age=0');
  res.writeHead(302, { Location: '/login' });
  res.end();
};

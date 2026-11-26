// Elo для командных матчей: сравниваем средние рейтинги сторон.
// Дельта нулевой суммы: сколько получила победившая сторона, столько потеряла проигравшая.
const K = 32;

const expected = (a, b) => 1 / (1 + Math.pow(10, (b - a) / 400));
const avg = (arr) => arr.reduce((s, x) => s + x, 0) / arr.length;

/**
 * @param {number[]} ratingsA рейтинги игроков стороны A
 * @param {number[]} ratingsB рейтинги игроков стороны B
 * @param {'A'|'B'} winner
 * @returns {{A:number, B:number}} изменение рейтинга каждого игрока стороны
 */
function computeDeltas(ratingsA, ratingsB, winner) {
  const ea = expected(avg(ratingsA), avg(ratingsB));
  const dA = Math.round(K * ((winner === 'A' ? 1 : 0) - ea));
  return { A: dA, B: -dA };
}

module.exports = { computeDeltas, expected, K };

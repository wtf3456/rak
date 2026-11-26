const assert = require('assert');
const { computeDeltas } = require('./rating');

// равные соперники: победитель +16, проигравший -16
assert.deepStrictEqual(computeDeltas([1000], [1000], 'A'), { A: 16, B: -16 });
// фаворит выиграл — получает меньше
assert.ok(computeDeltas([1200], [1000], 'A').A < 16);
// андердог выиграл — получает больше
assert.ok(computeDeltas([1000], [1200], 'A').A > 16);
// сумма всегда нулевая
const d = computeDeltas([1100, 900], [1000, 1000], 'B');
assert.strictEqual(d.A + d.B, 0);
console.log('rating tests ok');

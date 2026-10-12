const fs = require('fs');
const acorn = require('acorn');
for (const file of ['ui/app.js', 'ui/phone.js']) {
  acorn.parse(fs.readFileSync(file, 'utf8'), {ecmaVersion: 5});
  console.log(file + ': ES5 syntax passed');
}

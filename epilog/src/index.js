const fs = require('fs/promises');
const path = require('path');
const vm = require('node:vm');

const context = {};
vm.createContext(context);

async function init() {
    return fs.readFile(path.join(__dirname, '..', 'epilog.js'), { encoding: 'utf-8' }).then(code => {
        // eval epilog.js, tons of globals
        eval(code);

        return {
            find: function(data, rules, query) {
                const dataset = [];
                definefacts(dataset, readdata(data));
                const ruleset = [];
                definerules(ruleset, readdata(rules));
                return compfinds(read(query), read(query), dataset, ruleset);
            }
        };
    });
}

module.exports = {
    init
};
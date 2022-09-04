const epilog = require('./epilog.js');

class Explanation {
  fact = [];
  derivation = [];

  constructor(fact, facts, rules) {
    if (typeof fact === 'string') fact = epilog.read(fact);
    
    this.fact = fact;
    
    const explanation = explain(fact, facts, rules);

    if (typeof explanation === 'string') return;
    if (explanation[0] !== 'rule') return;
    if (explanation.length < 2) return;

    for (let i = 2; i < explanation.length; i++) {
      this.derivation.push(new Explanation(explanation[i], facts, rules));
    }
  }
}

//==============================================================================
// First argument p is a ground atom derivable from facts and rules.
// Value is a ground version of a rule used to derive the first argument.
// Can be applied recursively to get explanations for subgoals of that rule.
//==============================================================================


//Note from Preston Carlson: This does not check whether p is derivable from facts and rules. 
  //In that case, will simply return p, which is not desirable because p is returned as an explanation for some true facts. (e.g. "not" facts)
function explain(p, facts, rules)
 {//console.log("Explain: ", p);
  if (epilog.symbolp(p)) {return explainatom(p,facts,rules)}
  if (p[0]==='same') {return p}
  if (p[0]==='distinct') {return p}
  if (p[0]==='not') {return explainnot(p,facts,rules)}
  if (epilog.basep(p[0],rules)) {return explainbase(p,facts,rules)};
  return explainview(p,facts,rules)}

function explainatom (p,facts,rules)
 {if (p==='true') {return 'true'};
  if (p==='false') {return false};
  if (epilog.basep(p,rules)) {return explainbase(p,facts,rules)};
  return explainview(p,facts,rules)}

function explainnot (p,facts,rules)
 {return p}

function explainbase (p,facts,rules)
 {var data = epilog.lookupfacts(p,facts);
 //console.log('looked p',p);
 //console.log('looked facts',facts);
 //console.log('looked data',data);
 
  for (var i=0; i<data.length; i++)
      {if (epilog.equalp(data[i],p)) {
        //console.log("equaled:", data[i]);
        return p}};
  return p}

function explainview (p,facts,rules)
 {
  //Find potentially-applicable rules
  var data = epilog.lookuprules(p,rules);
  //console.log("explainview: ", data);
  //Check through each possible rule to find one valid explanation of p
  for (var i=0; i<data.length; i++)
      {//If valid explanation found, return it
        var result = explainviewrule(p,data[i],facts,rules);
        if (result) {
         //console.log("rule result: ", result);
         return result
        }};
  return p}

function explainviewrule (p,rule,facts,rules)
 { //Check if the rule applies to this conclusion
  var al = simplematcher(rule[1],p);
  if (al===false) {return false};
  //console.log("rule1: ", rule, al);
  //console.log('same',rule[1],p);
  //console.log([seq('same',rule[1],p)]);
  //console.log([seq('same',rule[1],p)].concat(rule.slice(2)));
  //Combines the fact that the conclusion and the rule are the same with the facts that define the rule
  //Note: Still not sure exactly what maksand is for. Adding 'and' to the front?
  var body = epilog.maksand([epilog.seq('same',rule[1],p)].concat(rule.slice(2)));
  //console.log('slice: ', rule.slice(2));
  //console.log('explainviewrule: ', body);

  var finalresult = epilog.compfindx(rule,body,facts,rules);

  //console.log("Finalresult: ",finalresult);
  return finalresult;
  //return compfindx(rule,body,facts,rules)
}

//==============================================================================
// Template matching and processing - from MRG
//==============================================================================
//------------------------------------------------------------------------------
// simplematcher
// simplematch
// simplematchvar
// simplematchexp
// simplematchvalue
// simplevalue
// plugstring
//------------------------------------------------------------------------------
//==============================================================================

function simplematcher (x,y)
 {return simplematch(x,y,[])}

function simplematch (x,y,bl)
 {if (epilog.varp(x)) {return simplematchvar(x,y,bl)};
  if (epilog.symbolp(x)) {if (x===y) {return bl} else {return false}};
  return simplematchexp(x,y,bl)}

function simplematchvar (x,y,bl)
 {var dum = simplevalue(x,bl);
  if (dum!==false) {if (epilog.equalp(dum,y)) {return bl} else {return false}};
  bl.push([x,y]);
  return bl}

function simplematchexp(x,y,bl)
 {if (epilog.symbolp(y)) {return false};
  if (x.length!==y.length) {return false};
  for (var i=0; i<x.length; i++)
      {bl = simplematch(x[i],y[i],bl);
       if (bl===false) {return false}};
  return bl}

function simplevalue (x,al)
 {for (var i=0; i<al.length; i++)
      {if (x===al[i][0]) {return al[i][1]}};
  return false}

function plugstring (x,al)
{
   //console.log(x);
   //console.log('al', al);
   for (var i=0; i<al.length; i++)
      {var pattern = new RegExp('\\$' + al[i][0] + '\\$','g');
       x = x.replace(pattern,al[i][1])};
  return x}

module.exports = { 
  Explanation,
  explain 
};
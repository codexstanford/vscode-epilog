const epilog = require('./epilog');
const db = require('./epilogDatabase');
const explain = require('./explain');

//==============================================================================
// english_explanation.js
//==============================================================================
//==============================================================================
// Functions to generate English-language explanations of Epilog derivations 
//==============================================================================

//==============================================================================
// External Interface (functions intended to be public)
//==============================================================================
// toEnglish
//==============================================================================

//==============================================================================
// Direct Dependencies
//==============================================================================
// {symbolp, read, grind, stripquotes, varp} from epilog.js
// {explain} from explain.js
// {isDerivableFact, getSymbolType, isAttributeRelation} from epilog_database.js
//==============================================================================

//==============================================================================
// classes
//==============================================================================
//------------------------------------------------------------------------------
// DerivationTree (class)
// FactWrapper (class)
//------------------------------------------------------------------------------

// A tree representation of the derivation of a ground atom
class DerivationTree {
    // groundAtom: A list or string representing an Epilog ground atom.
    constructor(groundAtom, facts, rules, metadata, english_templates, options) {
        if (typeof(groundAtom) === "string") {
            groundAtom = epilog.read(groundAtom);
        }

        this.root = new FactWrapper(groundAtom, facts, rules, metadata, english_templates, options);

        // Whether the root fact should appear in the explanation.
        this.visible = true;

        this.children = [];

        const explanation = explain.explain(groundAtom, facts, rules);
        
        // There are no children.
        if (typeof(explanation) === "string" ||
            explanation[0] !== "rule" ||
            explanation.length <= 2) {
            return;
        }
        
        
        // Recursively construct derivations of the facts used to derive the root
        for (let i = 2; i < explanation.length; i++) {
            this.children.push(new DerivationTree(explanation[i], facts, rules, metadata, english_templates, options));
        }
        
    }

    // Recursively removes subtrees/facts from the tree such that the tree has the provided maximum depth.
    // Removes all children if depth <= 0
    pruneToDepth(depth) {
        if (depth <= 0) {
            this.children = [];
            return;
        }

        for (let childTree of this.children) {
            childTree.pruneToDepth(depth-1);
        }

        return this;
    }

    // Sets the visibility of the every node in the tree to be newVisibility.
    // newVisibility should be a boolean.
    setTreeVisibility(newVisibility) {
        this.visible = newVisibility;

        for (let child of this.children) {
            child.setTreeVisibility(newVisibility);
        }
    }

    // Returns an array of strings containing all symbols matched by vars in templates of facts in the tree.
    // The facts in the tree are traversed in DFS order and symbols are added in the order they appear in template of the fact.
    // If onlyVisible is true, only considers symbols in visible nodes.
        // Should therefore be a subset of the keys of the symbolTypeMap for the tree.
    getMatchedSymbolsInOrder(onlyVisible) {
        let matchedSymbols = [];
        
        // If onlyVisible, only consider visible nodes.
        if (!(onlyVisible && !this.visible)) {
            for (let [varStr, replacementStr] of this.root.templateVarReplacementSeq) {
                matchedSymbols.push(this.root.templateMatchedVars.get(varStr));
            }
        }

        for (let child of this.children) {
            matchedSymbols = matchedSymbols.concat(child.getMatchedSymbolsInOrder(onlyVisible));
        }

        return matchedSymbols;
    }

    // Returns an array of FactWrappers containing all facts in the tree with templates that matched the given symbol.
    getFactsWithMatchedSymbol(matchedSymbol) {
        let factsWithSymbol = [];

        for (let [varStr, replacementStr] of this.root.templateVarReplacementSeq) {
            if (this.root.templateMatchedVars.get(varStr) === matchedSymbol) {
                factsWithSymbol.push(this.root);
            }
        }

        for (let child of this.children) {
            factsWithSymbol = factsWithSymbol.concat(child.getFactsWithMatchedSymbol(matchedSymbol));
        }

        return factsWithSymbol;
    }

    // Converts the DerivationTree into a nested list of FactWrappers. The Tree is traversed in DFS order.
    // depth: the maximum DFS traversal depth
        // If depth <= -1, the whole Tree is traversed.
    // Each subtree is represented as [root, [children]]
    toList(depth = 1) {
        if (depth === 0 || this.children.length === 0) {
            return [this.root, []];
        }

        let nextDepth = depth -1;

        // Traverse the whole tree
        if (depth <= -1) {
            nextDepth = -1;
        }

        let factList = [];

        factList.push(this.root);

        let childList = [];

        for (let i = 0; i < this.children.length; i++) {
            childList.push(this.children[i].toList(nextDepth));
        }

        factList.push(childList);

        return factList;
    }

    // Converts a DerivationTree or a nested list of FactWrappers into a 1D list in DFS order. 
    // Returns the 1D list.
    static asFlatList(treeOrList) {
        if (!((treeOrList instanceof DerivationTree) || Array.isArray(treeOrList))) {
            console.log("[Warning] DerivationTree.flatList - argument must be a DerivationTree of a list.");
            return treeOrList;
        }

        let nestedList;
        if (treeOrList instanceof DerivationTree) {
            // By default converts the entire tree.
            nestedList = treeOrList.toList(-1);
        }
        
        return nestedList.flat(Infinity);
    }

    // Applies a symbolReplacementMap to the templateVarReplacementSeq's in the visible nodes of the derivTree.
    static applySymbolReplacementMap(derivTree, symbolToReplacementMap) {
        let queue = [derivTree];
        while (queue.length !== 0) {
            //Remove from queue and add children
            let subtree = queue.shift();
            queue = queue.concat(subtree.children);
            
            // If not visible, ignore subtree.
            if (!subtree.visible) {
                continue;
            }

            // Update the templateVarReplacementSeq for the current node.
            let updatedReplacementSeq = subtree.root.templateVarReplacementSeq;
            for (let i = 0; i < updatedReplacementSeq.length; i++) {
                let matchedSymbol = subtree.root.templateMatchedVars.get(updatedReplacementSeq[i][0]);
                
                // Ignore untyped symbols.
                if (!symbolToReplacementMap.has(matchedSymbol)) {
                    continue;
                }

                updatedReplacementSeq[i][1] = symbolToReplacementMap.get(matchedSymbol);
            }

            subtree.root.templateVarReplacementSeq = updatedReplacementSeq;
        }
        return derivTree;
    }
}

// A wrapper class for Epilog facts to simplify converting to templates. 
class FactWrapper {
    // groundAtom: A list or string representing an Epilog ground atom.
    constructor(groundAtom, facts, rules, metadata, english_templates, options) {
        //Convert to list format
        if (typeof(groundAtom) === 'string') {
            groundAtom = epilog.read(groundAtom);
        }
        this.groundAtom = groundAtom;
        
        //Find matching template, if it exists
        let proceduralTemplateType = "";
        [this.unfilledTemplate, this.templateMatchedVars, this.templateVarReplacementSeq, proceduralTemplateType] = getMatchingTemplate(this.groundAtom, english_templates);

        if (this.unfilledTemplate === false) {
            this.unfilledTemplate = epilog.grind(this.groundAtom);
        }

        // validate that, if a procedural template is being used, it is being applied appropriately to the fact.
            // All construction of the fact should be finished before performing this check.
        switch (proceduralTemplateType) {
            case 'none':
                break;

            case 'attributeRelation_unique':
                let relation = this.getPredicateSymbol();
                if (!db.isAttributeRelation(relation, facts, rules, metadata, options)) {
                    console.log("[Warning] FactWrapper constructor - procedural template of type attributeRelation_unique has matched a non-attribute relation fact.");
                    break;
                }

                let classInstance = this.getClassInstanceIfAttribute(facts, rules, metadata, options);

                if (!isUniqueAttributeForInstance(relation, classInstance, facts, rules, metadata, options)) {
                    console.log("[Warning] FactWrapper constructor - procedural template of type attributeRelation_unique has matched an attribute that \
                                 is not unique for the class instance:", this.asString());
                    break;
                }

                break;
            default:
                break;
        }
    }

    asList() {
        return this.groundAtom;
    }

    asString() {
        return epilog.grind(this.groundAtom);
    }

    // Returns the string of the groundAtom's predicate if it exists.
    // If not, returns false.
    getPredicateSymbol() {
        const listAtom = this.asList();
        if (epilog.symbolp(listAtom)) {
            return false;
        }

        if (listAtom[0] === 'rule') {
            return listAtom[1][0];
        }

        return listAtom[0];
    }

    // Returns a Set of strings of the groundAtom's non-predicate symbols, if they exist.
    // If none found, returns an empty Set.
    getNonPredicateSymbols() {
        const listAtom = this.asList();
        
        if (epilog.symbolp(listAtom)) {
            return new Set([listAtom]);
        }

        let symbolList = [];

        // Exclude the predicate and 'rule'
        let queue = listAtom.slice(1);
        let elem;

        while ((typeof(elem = queue.shift()) !== 'undefined')) {
            if (epilog.symbolp(elem)) {
                symbolList.push(elem);
            } else 
            // Add elems to the queue, excluding predicates and 'rule'
            if (Array.isArray(elem)) {
                queue = queue.concat(elem.slice(1));
            }
        }

        return new Set(symbolList);

    }

    // If an attribute relation fact, returns a string containing the value of the attribute.
    // If not an attribute relation fact, returns false.
    getValueIfAttribute(facts, rules, metadata, options) {
        if (!db.isAttributeRelation(this.getPredicateSymbol(), facts, rules, metadata, options)) {
            return false;
        }

        let listAtom = this.asList();
        let attributeValue = listAtom[listAtom.length - 1];
        if (typeof attributeValue !== "string") {
            attributeValue = epilog.grind(attributeValue);
        }

        return attributeValue;

    }

    // If an attribute relation fact, returns a string containing the class instance of the attribute. (I.e. the first argument)
    // If not an attribute relation fact, returns false.
    getClassInstanceIfAttribute(facts, rules, metadata, options) {
        if (!db.isAttributeRelation(this.getPredicateSymbol(), facts, rules, metadata, options)) {
            return false;
        }

        let listAtom = this.asList();
        let classInstance = listAtom[listAtom.length - 2];
        if (typeof classInstance !== "string") {
            classInstance = epilog.grind(classInstance);
        }

        return classInstance;
    }

    //Returns the unfilledTemplate with vars replaced as specified by the templateVarReplacementSeq
    getFilledTemplate() {
        let strToFill = epilog.stripquotes(this.unfilledTemplate);

        for (let i=0; i<this.templateVarReplacementSeq.length; i++) {
            const replacementPair = this.templateVarReplacementSeq[i];
            let re = new RegExp('\\$' + replacementPair[0] + '\\$','i');

            strToFill = strToFill.replace(re,replacementPair[1]);
        }

        return strToFill;
    }
}

//==============================================================================
// High-level natural language generation
//==============================================================================
//------------------------------------------------------------------------------
// toEnglish
// pruneDerivTree
// performTreeVisibilityPasses
// performSymbolReplacementPasses
// derivTreeToEnglish
//------------------------------------------------------------------------------

/* Returns a string of the English explanation of the conclusion based on 
 * the given facts, rules, metadata, english_templates, and options.
 * 
 * Assumes facts, rules, metadata, and english_templates have been
 * loaded via localstorage.js
 * 
 * The Epilog derivation of the conclusion is derived from the facts and rules.
 * The English explanation of this derivation is generated using the metadata
 * and english_templates.
 * The generated explanation can be changed via the options, the effects of which 
 * are as follows:
 * 
 *      typePredicate: the predicate used in the database of facts to indicate the type of a constant. e.g. type(claim21, claim)
 *      replaceWithType: whether to replace constants in explanations with their type. e.g. "the hospitalization of claim21 is hospitalization21" becomes "the hospitalization of the claim is the hospitalization"
 *      removeClassAttributes: whether to remove class attribute facts from explanations. e.g. claim.hospitalization(claim21, hospitalization21)
 *      bindLocalConstants: whether to bind class attributes to class they were introduced as belonging to. No effect if replaceWithType is false. e.g. "the hospitalization of claim21 is hospitalization21" becomes "the hospitalization of the claim is the hospitalization of the claim"
 *      verifyDerivable: whether to verify that the fact to be explained is derivable from the given facts and rules. Without this, all facts are assumed derivable/true.
 *      useMetadata [not implemented]: whether to use metadata in determining properties of predicates in the database. e.g. whether claim.hospitalization is an attributerelation, or whether claim is a class
 *      linkFromExplanation: whether each fact in an explanation should be a hyperlink to the page explaining that fact.
 *      linkGivenFacts:  whether facts that are not derivable and are given as true should be hyperlinked as above. No effect if linkFromExplanation is false.
 * 
 */
export function toEnglish(conclusion,
                   facts,
                   rules,
                   metadata,
                   english_templates, 
                   options) {

    // Note: If replaceWithType is false, bindLocalConstants is irrelevant
    // Note: if linkFromExplanation is false, linkGivenFacts is irrelevant

    const defaults = {
        typePredicate: "type",
        replaceWithType: true,
        removeClassAttributes: false,
        bindLocalConstants: true,
        verifyDerivable: true,
        useMetadata: true,
        linkFromExplanation: true,
        linkGivenFacts: true };
    options = Object.assign({}, defaults, options);
    
    // Check whether the conclusion is true before translating
    if (options.verifyDerivable && !db.isDerivableFact(conclusion, facts, rules)) {
        console.log("[Warning] toEnglish -", conclusion, "is not derivable from the given facts and rules.");
        return conclusion + " is not derivable from the given facts and rules.";
    }

    // Generate the DerivationTree for the given conclusion. This is a complete representation of the derivation.
    let derivTree = new DerivationTree(conclusion, facts, rules, metadata, english_templates, options);

    // Remove subtrees/facts that will not be taken into account for the explanation.
    derivTree = pruneDerivTree(derivTree, options);
    
    // Set visible to false for subtrees/facts that will not appear in the explanation, 
        // but the information of which we still want to take into account when constructing the explanation.
    derivTree = performTreeVisibilityPasses(derivTree, facts, rules, metadata, options);


    // Perform all passes replacing matched symbols in templates.
    derivTree = performSymbolReplacementPasses(derivTree, facts, rules, metadata, options);

    //console.log(derivTree);

    let englishExplanation = derivTreeToEnglish(derivTree, facts, rules, metadata, english_templates, options);

    return englishExplanation;
}

/* Removes subtrees/facts from a DerivationTree so that they are not taken into account in an explanation.
 * Removing the root of a subtree removes the entire subtree.
 *
 * The tree is modified in-place.
 * 
 * Returns the pruned DerivationTree.
 */
function pruneDerivTree(derivTree, options) {
    // For now, just sets a prunes to a depth of 1.
    return derivTree.pruneToDepth(1);
}

/* Sets visible to false for subtrees/facts that want not to appear in the explanation, 
 * but the information of which we still want to take into account.
 *
 * Paramaterized by the options.
 * 
 * Modifies the derivTree in-place.
 * 
 * Returns the updated derivTree.
 */
function performTreeVisibilityPasses(derivTree, facts, rules, metadata, options) {

    // For now, if a root is not visible, then every node in its subtree is not visible.

    // Hide attribute relation facts under the following conditions:
    //      - the range of the attribute is unique (for the class instance in the fact)
    //      - the class instance has no other attributes with the same range
    //      - the attribute value is the only symbol of its type in the explanation 
    //
    //      Should add additional restrictions so that attribute facts are not removed when their removal would make the explanation ambiguous (or remove all facts),
    //          but the exact conditions are more complex than I would like. Tried the below, but this was overly restrictive.
    //          For now, will rely on the user to decide whether to removeClassAttributes or not.
    //          (E.g. The current conditions work well for plan_in_effect, but remove all explanation facts in same_continent.)
    //      Attempted additional condition:
    //      - the attribute value appears in at least one non-attribute fact in the explanation
    //          - Just appearing as a non-attribute value is not enough, as it could still be hidden if it only appears in attribute facts and its attributes are hidden.
    if (options.removeClassAttributes) {
        let symbolTypeMap = constructSymbolTypeMap(derivTree, facts, rules, options);

        // The initial root should always be visible.
        let queue = [...derivTree.children];

        // For each subtree in queue
        while (queue.length !== 0) {
            let subtree = queue.shift();
            
            // Ignore subtrees with an invisible root.
            if (!subtree.visible) {
                continue;
            }

            let predicateSymbol = subtree.root.getPredicateSymbol();
            let classInstance = subtree.root.getClassInstanceIfAttribute(facts, rules, metadata, options);

            if (db.isAttributeRelation(predicateSymbol, facts, rules, metadata, options) && 
                isUniqueAttributeForInstance(predicateSymbol, classInstance, facts, rules, metadata, options) &&
                isOnlyAttributeOfTypeForInstance(predicateSymbol, classInstance, facts, rules, metadata, options)) {
                    
                    let valType = getRangeOfAttribute(predicateSymbol, facts, rules, metadata, options);

                    let appearsInNonAttributeFact = true;
                    /*let val = subtree.root.getValueIfAttribute(facts, rules, metadata, options);
                    let factsWithMatchedSymbol = derivTree.getFactsWithMatchedSymbol(val);


                    let appearsInNonAttributeFact = false;
                    for (let fact of factsWithMatchedSymbol) {
                        // Don't count the conclusion
                        if (fact !== derivTree.root && !db.isAttributeRelation(fact.getPredicateSymbol(), facts, rules, metadata, options)) {
                            appearsInNonAttributeFact = true;
                            break;
                        }
                    }

                    console.log("appears in other fact:",val,appearsInNonAttributeFact,factsWithMatchedSymbol);*/

                    // Verify that this value is the only object of its type in the explanation.
                    // If so, hide this subtree and ignore its children.
                    if (appearsInNonAttributeFact && [...symbolTypeMap.keys()].filter(key => symbolTypeMap.get(key) === valType).length === 1) {
                        subtree.setTreeVisibility(false);
                        continue;
                    }

            }

            queue.concat(subtree.children);
        }
    }

    //console.log("setvisibilitytree",derivTree);
    return derivTree;
}

/* Performs passes to update the templateVarReplacementSeq properties of the facts in the derivTree.
 * options controls which passes are performed.
 * 
 * 
 * Modifies the DerivationTree in-place.
 */
function performSymbolReplacementPasses(derivTree, facts, rules, metadata, options) {
    if (options.replaceWithType) {
        // Replace object symbols with "the [type]" as a baseline.
        let symbolToReplacementMap;
        [derivTree, symbolToReplacementMap] = replaceSymbolsWithTypes(derivTree, facts, rules, metadata, options);
        
        // Rare/niche pass!
            // Replaces the first instance of a given class attribute with "the [attribute range] of the [attribute domain]",
            // but only if it is the only symbol in the explanation of its type and it appears as a value in an attribute fact that is not visible.
        if (options.bindLocalConstants) {
            derivTree = bindClassAttributeSymbols(derivTree, symbolToReplacementMap, facts, rules, metadata, options);
        }
    }

    return derivTree;
}

/* Combines and fills the templates of the facts of the derivTree to generate an natural language explanation.
 * 
 * For now, only handle the case where the derivTree has depth 1.
 * It seems we'll be keeping trees of depth 1 for the foreseeable future, since the simplicity this affords is extremely beneficial for testing NLG of explanations.
 * Maybe move the above note to Obsidian. (8/1/2022)
 */
function derivTreeToEnglish(derivTree, facts, rules, metadata, english_templates, options) {

    //Treat the conclusion differently
    let englishExplanation = derivTree.root.getFilledTemplate();

    // No further explanation is required/available.
        // Note that this condition can be met if the tree was pruned to depth 0.
    if (derivTree.children.length === 0) {
        return "It is given that " + englishExplanation;
    }


    // Process any child facts
    englishExplanation += " because \n \t";
    let childExplanationList = [];

    for (let child of derivTree.children) {
        if (!child.visible) {
            continue;
        }

        let childExplanation = child.root.getFilledTemplate();

        //If linkFromExplanation, generate a link to an explanation for each fact in the explanation.
        if (options.linkFromExplanation) {
            //If linkGivenFacts is false, don't link facts without children. (i.e. those that don't have derivations, and are simply given as true)
            if (options.linkGivenFacts || (new DerivationTree(child.root.asString(), facts, rules, metadata, english_templates, options)).children.length > 0) {
                childExplanation = factLinkElem(child.root, childExplanation);
            }
        }
        childExplanationList.push(childExplanation);
    }
    
    englishExplanation += childExplanationList.join(" and \n \t");
    return englishExplanation;
}

//==============================================================================
// Symbol replacement passes
//==============================================================================
//------------------------------------------------------------------------------
//--------------------------- Type Replacement ---------------------------------
// replaceSymbolsWithTypes
// 
// bindClassAttributeSymbols
//------------------------------------------------------------------------------

/* Returns a DerivationTree where the varReplacementSeq of each fact is updated  
 * such that each symbol is replaced with its type as "the [type]", as long as it is the only symbol of its type in the explanation.
 *
 * The derivTree is modified in-place.
 */
function replaceSymbolsWithTypes(derivTree, facts, rules, metadata, options) {
    if (!derivTree instanceof DerivationTree) {
        console.log("[Warning] replaceSymbolsWithTypes - first argument must be a DerivationTree.");
        return derivTree;
    }
    
    // Make a map of each type to an ordered sequence of the symbols of that type in the explanation.
    let typeToSymbolsMap = constructTypeToOrderedSymbolsMap(derivTree, facts, rules, options);

    // Make a map of each symbol to its replacement string.
    // Ignores untyped symbols.
    let symbolToTypeReplacementMap = new Map();

    for (const [symbolType, symbolsOfType] of typeToSymbolsMap) {
        const numSymbolsOfType = symbolsOfType.length;

        // For each symbol, replace it with...
            // "the [type]" if it is the only symbol of its type in the explanation.
            // "the (ordinal) [type]" otherwise.
        // This should work reasonably well as-is. The primary future improvement will be varying the determiner used before the type.
        for (let i = 0; i<numSymbolsOfType; i++) {
            const symbol = symbolsOfType[i];
            const symbolTypeStr = symbolType;

            // No ordinal necessary if only symbol of type in the explanation.
            if (numSymbolsOfType === 1) {
                symbolToTypeReplacementMap.set(symbol, "the " + symbolTypeStr);
                continue;
            }

            symbolToTypeReplacementMap.set(symbol, "the " + ordinalNumeralFor(i+1) + " " + symbolTypeStr);
        }
    }

    //console.log("replacementmap",symbolToTypeReplacementMap);

    // Apply these replacements to the templateVarReplacementSeq's in the visible nodes of the derivTree.
    derivTree = DerivationTree.applySymbolReplacementMap(derivTree, symbolToTypeReplacementMap, -1);

    //console.log("subbed derivTree",derivTree);

    return [derivTree, symbolToTypeReplacementMap];
}

/* Returns a DerivationTree where...
 *          - if a symbol is an attribute value,
 *          - and the attribute relation fact where it is specified is not visible,
 *              - then the first occurrence of that symbol is replaced with "the [attribute range] of the [attribute domain]"
 *
 * Only perform the replacement if the attribute relation is typed, unique, it is the only attribute relation of the class with that range,
 * and the value is the only object in the explanation of its type.
 * 
 * symbolToReplacementMap is used to find how the class instance with the attribute is referred.
 * 
 * The derivTree is modified in-place.
 * 
 * This pass is performed only in very specific situations, so okay with the implementation details being dependent on the specifics of hiding attribute relation facts,
 * especially since it there are *many* conditions that must be met in order to perform this substitution and keeping those synced between 
 * two functions would be bug-prone.
 */
function bindClassAttributeSymbols(derivTree, symbolToReplacementMap, facts, rules, metadata, options) {
    
    // Find all attribute facts in the derivTree that are not visible and build their new replacement strings.
    let symbolToBoundReplacementMap = new Map();

    // Set the bound replacement str for the values that meet the conditions.
    let queue = [derivTree];
    while (queue.length !== 0) {
        // Update the queue
        let subtree = queue.shift();
        queue = queue.concat(subtree.children);

        let relation = subtree.root.getPredicateSymbol();

        if (!subtree.visible && 
            db.isAttributeRelation(relation, facts, rules, metadata, options)) {

            // Only consider the first class instance that has val as an attribute value.
            let val = subtree.root.getValueIfAttribute(facts, rules, metadata, options);
            if (symbolToBoundReplacementMap.has(val)) {
                continue;
            }

            let valType = db.getSymbolType(val, facts, rules, options.typePredicate);
            let classInstance = subtree.root.getClassInstanceIfAttribute(facts, rules, metadata, options);

            let boundReplacementStr = "the " + valType + " of ";
            if (symbolToReplacementMap.has(classInstance)) {
                boundReplacementStr += symbolToReplacementMap.get(classInstance);
            } else {
                boundReplacementStr += classInstance;
            }

            symbolToBoundReplacementMap.set(val, boundReplacementStr);
        }
    }

    //console.log("boundmap",[...symbolToBoundReplacementMap.entries()])
    
    // Update the templateVarReplacementSeq for the initial occurrence of each symbol in the bound replacement map.
    let substitutionQueue = [derivTree]; 

    while (substitutionQueue.length !== 0 && symbolToBoundReplacementMap.size !== 0) {
        let subtree = substitutionQueue.shift();
        substitutionQueue = substitutionQueue.concat(subtree.children);

        if (!subtree.visible) {
            continue;
        }

        // Update the templateVarReplacementSeq for the current node.
        let updatedReplacementSeq = subtree.root.templateVarReplacementSeq;
        for (let i = 0; i < updatedReplacementSeq.length; i++) {
            let matchedSymbol = subtree.root.templateMatchedVars.get(updatedReplacementSeq[i][0]);
            
            // Ignore unbound and repeat symbols.
            if (!symbolToBoundReplacementMap.has(matchedSymbol)) {
                continue;
            }

            updatedReplacementSeq[i][1] = symbolToBoundReplacementMap.get(matchedSymbol);

            // Only apply the replacement once, so remove from the map.
            symbolToBoundReplacementMap.delete(matchedSymbol);
        }

        subtree.root.templateVarReplacementSeq = updatedReplacementSeq;
    }
    

    //console.log("Bound derivTree", derivTree);
    return derivTree;
}

//==============================================================================
// Helpers for type replacement passes
//==============================================================================
//------------------------------------------------------------------------------
// constructSymbolTypeMap
// constructTypeToOrderedSymbolsMap
//------------------------------------------------------------------------------


/* Returns a map where each...
 *      - key is a symbol that matched a var in a template of a fact in the derivTree
 *      - value is the type of the symbol, either a string, or false if the symbol has no type
 */
function constructSymbolTypeMap(derivTree, facts, rules, options) {
    if (!derivTree instanceof DerivationTree) {
        console.log("[Warning] constructSymbolTypeMap - first argument must be a DerivationTRee.");
        return new Map();
    }

    let symbolTypeMap = new Map();

    let queue = [derivTree];
    
    while (queue.length !== 0) {
        let subtree = queue.shift();

        // Add each new symbol (which matched a template variable) and its type to the map
        for (const symbol of subtree.root.templateMatchedVars.values()) {
            if (symbolTypeMap.has(symbol)) {
                continue;
            }

            symbolTypeMap.set(symbol, db.getSymbolType(symbol, facts, rules, options.typePredicate));
        }


        if (subtree.children.length !== 0) {
            queue = queue.concat(subtree.children);
        }
    }

    return symbolTypeMap;
}

/* Returns a map where...
 *      - key is a string representing a type in the facts database
 *      - value is an array of distinct symbols in the explanation with that type.
 *
 * The symbols will appear in their array in the order they appear in visibleSymbolsInOrder.
 *      (And therefore we only consider symbols in visible subtrees)
 * The array will contain no duplicate elements (like a Set) but is an array to retain ordering.
 */
function constructTypeToOrderedSymbolsMap(derivTree, facts, rules, options) {
    // Get all symbols that will appear in the explanation which matched vars in templates.
        // Should therefore be a subset of the keys of the symbolTypeMap for the tree.
    let visibleSymbolsInOrder = derivTree.getMatchedSymbolsInOrder(true);

    // Make a map from each type to an array of distinct symbols in the explanation with that type.
        // The symbols will appear in their array in the order they appear in visibleSymbolsInOrder.
        // The array will contain no duplicate elements (like a Set) but is kept an array for the ordering.
    let typeToSymbolsMap = new Map();
    for (const symbol of new Set(visibleSymbolsInOrder)) {
    
        const symbolType = db.getSymbolType(symbol, facts, rules, options.typePredicate);

        // Ignore untyped symbols.
        if (symbolType === false) {
            continue;
        }

        // First symbol seen of type.
        if (!typeToSymbolsMap.has(symbolType)) {
            typeToSymbolsMap.set(symbolType, [symbol]);
            continue
        }

        let seenSymbols = typeToSymbolsMap.get(symbolType);

        // Ignore repeat.
        if ((new Set(seenSymbols)).has(symbol)) {
            continue;
        }

        // Is a new symbol of the type, so add to the end of the array.
        typeToSymbolsMap.set(symbolType, seenSymbols.concat([symbol]));        
    }

    return typeToSymbolsMap;
}

//==============================================================================
// Natural language generation utilities
//==============================================================================
//------------------------------------------------------------------------------
// getMatchingTemplate
// factLinkElem
//------------------------------------------------------------------------------

/* Finds and returns the first template matching the ground atom.
 * groundAtom: A string or list representing an Epilog ground atom
 * 
 * If one is found, returns an array containing
 * i. the unfilled template string
 * ii. an object mapping variables in the template string to constants
 * iii. a 2D array of pairs of strings where...
 *      a. the first element of each pair is a variable in a template to be replaced
 *      b. the second element of each pair is the epilog constant that should be substituted for the variable in the template
 *      c. the pairs appear in the list in the same order as do the corresponding variables in the template
 * If no template is found, returns [false, {}, []].
 * 
 * e.g. if groundAtom = "claim.policy(claim21,policy21)" and 
 *      english_templates = [new TemplateWrapper("claim.policy(C,P)", "the policy of $C$ is $P$", ["C", "P"]),
                            new TemplateWrapper("policy.startdate(P,S)", "$P$ began on $S$", ["P", "S"])],
        returns ["claim.policy(C,P)",
                 {"C": "claim21", "P": "policy21"},
                 [ ["C", "claim21"], ["P", "policy21"] ]
                ]
 * 
 * Intent: Enable distinguishing between different instances of a variable/constant in templates and explanations.
 * The 2D array allows us to perform per-instance substitutions of the variables.
 * The object mapping variable to constants allows us to remember which constants the variables
 * originally matched to, regardless of the transformations performed on the 2D array.
 */
function getMatchingTemplate(groundAtom, english_templates) {
    //Convert to list format
    if (typeof(groundAtom) === "string") {
        groundAtom = epilog.read(groundAtom);
    }

    //Find the matching template
    for (let i=0; i < english_templates.length; i++) {
        let matchedVars = simplematcher(english_templates[i].getQueryAsList(), groundAtom);
        
        //Matching template found
        if (matchedVars !== false) {
            let matchedVarMap = new Map(matchedVars);
            let matchedTemplate = english_templates[i];
            let varReplacementSeq = [];
            matchedTemplate.varSequence.forEach((varStr) => {
                varReplacementSeq.push([varStr, matchedVarMap.get(varStr)]);
            });

            return [matchedTemplate.templateString, matchedVarMap, varReplacementSeq, matchedTemplate.proceduralType];
        }
    }

    //No matching template
    return [false, new Map(), []];
    
}

// Return an HTML element linking to the page explaining the given fact, 
// with text equal to linkText.
function factLinkElem(fact, linkText){
    if (! fact instanceof FactWrapper) {
        const errorMsg = "[Warning] factLinkElem - first arg must be a FactWrapper.";
        console.log(errorMsg);
        return errorMsg;
    }
    return"<a href='index.html?conclusion=" + fact.asString() + "'>" + linkText + "</a>"
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
  if (dum!==false) {if (equalp(dum,y)) {return bl} else {return false}};
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
const epilog = require('./epilog');

//==============================================================================
// epilog_database.js
//==============================================================================
//==============================================================================
// Functions to answer questions about relations, rules,
// and facts in a given Epilog database.
//==============================================================================

//==============================================================================
// External Interface (functions intended to be public)
//==============================================================================
// isDerivableFact
// getSymbolType
// isClass
// isAttributeRelation
// isAttributeOfClass
// getClassOfAttribute
//==============================================================================

//==============================================================================
// Direct Dependencies
//==============================================================================
// {basefindp, basefinds, basefindx, compfindp, read, symbolp} from epilog.js
//==============================================================================

//==============================================================================
// functions about instantiated facts/rules
//==============================================================================
//------------------------------------------------------------------------------
// isDerivableFact
// getSymbolType
// isClass
// isAttributeRelation
// isAttributeOfClass
// getClassOfAttribute
//------------------------------------------------------------------------------

// General TODO: implement checks without metadata

//Determine whether a groundAtom is derivable from the given facts and rules
export function isDerivableFact(groundAtom, facts, rules) {
    if (typeof(groundAtom) === "string") {
        groundAtom = epilog.read(groundAtom);
    }
    
    //Must use compfindp, not basefindp. basefindp doesn't handle functions like evaluate
    return epilog.compfindp(groundAtom, facts, rules);
}

// Returns the type of the symbol if its type is specified in facts. Returns false otherwise.
export function getSymbolType(symbol, facts, rules, typePredicate) {
    if (!epilog.symbolp(symbol)) {
        console.log("[Warning] getSymbolType - first argument must be a symbol string.");
        return false;
    }

    const type = epilog.basefindx('T',epilog.read(typePredicate + '('+symbol+',T)'), facts, rules);

    return type;
}

// Determines whether relation is an attribute relation of className
export function isAttributeOfClass(relation, className, facts, rules, metadata, options) {
    if (relation === false) {
        return false;
    }
    //Begin input validation
    if (typeof(relation) !== "string") {
        console.log("[Warning] isAttributeOfClass - first argument must be a string.");
        return false;
    }
    if (typeof(className) !== "string") {
        console.log("[Warning] isAttributeOfClass - second argument must be a string.");
        return false;
    }
    if (!isClass(className, facts, rules, metadata, options)) {
        console.log("[Warning] isAttributeOfClass - className must be a class.");
        return false;
    }
    //End Input validation

    let isAttribute = isAttributeRelation(relation, facts, rules, metadata, options);
    let belongsToClass = false;

    if (!isAttribute) {
        //console.log(relation,"is not an attribute relation.");
        return false;
    }

    if (options.useMetadata) {
        return epilog.basefindp(epilog.read('attribute(' + className + ',' + relation + ')'), metadata, []);
    }

    return belongsToClass;

}

// Determines whether the given relation is an attribute relation.
export function isAttributeRelation(relation, facts, rules, metadata, options) {
    if (typeof(relation) !== "string") {
        console.log("[Warning] isAttributeRelation - first argument must be a string.");
        return false;
    }

    if (options.useMetadata) {
        return epilog.basefindp(epilog.read('type(' + relation + ',attributerelation)'), metadata, []);
    }

    return false;
}

// Determines whether the given className is a class.
export function isClass(className, facts, rules, metadata, options) {
    // getSymbolType can return false if a constant doesn't have a specified type.
    if (className === false) {
        return false;
    }

    if (typeof(className) !== "string") {
        console.log("[Warning] isClass - first argument must be a string:",className);
        return false;
    }

    if (options.useMetadata) {
        return epilog.basefindp(epilog.read('type(' + className + ',class)'), metadata, []);
    }

    return false;
}

// Gets the class that the given attribute relation belongs to
export function getClassOfAttribute(attributeRelation, facts, rules, metadata, options) {
    if (typeof(attributeRelation) !== "string") {
        console.log("[Warning] getClassOfAttribute - first argument must be a string.");
        return false;
    }

    if (!isAttributeRelation(attributeRelation, facts, rules, metadata, options)) {
        console.log("[Warning] getClassOfAttribute -", attributeRelation, "is not an attributerelation.");
        return false;
    }

    if (options.useMetadata) {
        return epilog.basefindx('X',epilog.read('attribute(X,'+attributeRelation+')'), metadata, []);
    }

    return false;
}

// Returns the range of the given attribute relation as a string.
function getRangeOfAttribute(attributeRelation, facts, rules, metadata, options) {
    if (typeof(attributeRelation) !== "string") {
        console.log("[Warning] getRangeOfAttribute - first argument must be a string.");
        return false;
    }

    if (!isAttributeRelation(attributeRelation, facts, rules, metadata, options)) {
        console.log("[Warning] getRangeOfAttribute -", attributeRelation, "is not an attributerelation.");
        return false;
    }

    if (options.useMetadata) {
        return epilog.basefindx('Y',epilog.read('range('+attributeRelation+',Y)'), metadata, []);
    }
    
    return false;
}

// Returns an array of strings containing all of the attribute relations of the given class.
function getAttributesOfClass(className, facts, rules, metadata, options) {
    if (typeof(className) !== "string") {
        console.log("[Warning] getAttributesOfClass - first argument must be a string:",className);
        return [];
    }
    
    if (!isClass(className, facts, rules, metadata, options)) {
        console.log("[Warning] getAttributesOfClass - first argument must be a class:",className);
        return [];
    }
    
    if (options.useMetadata) {
        return epilog.basefinds('Y',epilog.read('attribute('+className+',Y)'), metadata, []);
    }

    return [];
}

// Determines whether the given attribute relation is unique.
function isUniqueAttribute(attributeRelation, facts, rules, metadata, options) {
    if (typeof(attributeRelation) !== "string") {
        console.log("[Warning] isUniqueAttribute - first argument must be a string.");
        return false;
    }

    if (!isAttributeRelation(attributeRelation, facts, rules, metadata, options)) {
        console.log("[Warning] isUniqueAttribute -", attributeRelation, "is not an attributerelation.");
        return false;
    }

    if (options.useMetadata) {
        return epilog.basefindp(epilog.read('unique(' + attributeRelation + ',yes)'), metadata, []);
    }

    return false;
}

// Determines whether there is at most 1 fact with predicate attributeRelation for the given class instance.
function isUniqueAttributeForInstance(attributeRelation, classInstance, facts, rules, metadata, options) {
    /*     Begin input validation    */
    if (typeof(attributeRelation) !== "string") {
        console.log("[Warning] isUniqueAttributeForInstance - first argument must be a string.");
        return false;
    }

    if (!isAttributeRelation(attributeRelation, facts, rules, metadata, options)) {
        console.log("[Warning] isUniqueAttributeForInstance -", attributeRelation, "is not an attributerelation.");
        return false;
    }

    let classInstanceType = getSymbolType(classInstance, facts, rules, options.typePredicate);

    if (!isClass(classInstanceType, facts, rules, metadata, options)) {
        console.log("[Warning] isUniqueAttributeForInstance -", classInstance, "is not an instance of a class.");
        return false;
    }

    if (!isAttributeOfClass(attributeRelation, classInstanceType, facts, rules, metadata, options)) {
        console.log("[Warning] isUniqueAttributeForInstance -", classInstanceType, "does not have attribute", attributeRelation,".");
        return false;
    }
    /*     End input validation    */

    // If metadata says it is unique, it is unique.
    if (isUniqueAttribute(attributeRelation, facts, rules, metadata, options)) {
        return true;
    }

    if (options.useMetadata) {
        // There is only one value of this attribute for the given class instance.
        return !(compfinds('Y',epilog.read(attributeRelation+'('+classInstance+',Y)'), facts, rules).length > 1);
    }

    return false;
}

// Determines whether is at most one attribute value of the same type as the second argument of attributeRelation for the given class instance.
function isOnlyAttributeOfTypeForInstance(attributeRelation, classInstance, facts, rules, metadata, options) {
    /*     Begin input validation    */
    if (typeof(attributeRelation) !== "string") {
        console.log("[Warning] isOnlyAttributeOfTypeForInstance - first argument must be a string.");
        return false;
    }

    if (!isAttributeRelation(attributeRelation, facts, rules, metadata, options)) {
        console.log("[Warning] isOnlyAttributeOfTypeForInstance -", attributeRelation, "is not an attributerelation.");
        return false;
    }

    let classInstanceType = getSymbolType(classInstance, facts, rules, options.typePredicate);

    if (!isClass(classInstanceType, facts, rules, metadata, options)) {
        console.log("[Warning] isOnlyAttributeOfTypeForInstance -", classInstance, "is not an instance of a class.");
        return false;
    }

    if (!isAttributeOfClass(attributeRelation, classInstanceType, facts, rules, metadata, options)) {
        console.log("[Warning] isOnlyAttributeOfTypeForInstance -", classInstanceType, "does not have attribute", attributeRelation,".");
        return false;
    }

    // Verify there is at least one value of attributeRelation for the given class instance.
    if (!epilog.compfindp(epilog.read(attributeRelation+'('+classInstance+',Y)'), facts, rules)) {
        console.log("[Warning] isOnlyAttributeOfTypeForInstance -", classInstance, "does not have attribute value for", attributeRelation,".");
        return false;
    }
    /*     End input validation    */

    if (options.useMetadata) {
        let attributeRange = getRangeOfAttribute(attributeRelation, facts, rules, metadata, options);
        let attributesOfClass = getAttributesOfClass(classInstanceType, facts, rules, metadata, options);
        let attributeFactsOfInstanceWithRange = [];

        // Get all attribute facts for the class instance with range attributeRange.
        for (let currAttributeRelation of attributesOfClass) {
            // Attributes with different range cannot have type overlap with the attributeRelation.
            if (getRangeOfAttribute(currAttributeRelation, facts, rules, metadata, options) !== attributeRange) {
                continue;
            }

            attributeFactsOfInstanceWithRange = attributeFactsOfInstanceWithRange.concat(compfinds(epilog.read(currAttributeRelation+'('+classInstance+',Y)'),epilog.read(currAttributeRelation+'('+classInstance+',Y)'), facts, rules));
        }

        return attributeFactsOfInstanceWithRange.length === 1;
    }

}
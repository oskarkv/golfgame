define(["ramda"], function(r) {
    "use strict";

    var u = {};

    u.map = function(f) {
        var result = [];
        var lists = r.drop(1, arguments);
        for (var i = 0; true; i++) {
            var currents = r.map(r.nth(i), lists);
            if (r.all(r.compose(r.not, r.isNil), currents)) {
                result.push(r.apply(f, currents))
            } else {
                return result;
            }
        }
    };

    u.updateNumber = function(index, change, array) {
        return r.update(index, array[index] + change, array);
    };

    u.repeatedly = function(n, f) {
        return r.map(f, r.range(0, n));
    };

    u.cons = function(val, coll) {
        coll = r.map(r.identity, coll);
        coll.unshift(val);
        return coll;
    };

    u.concat = function() {
        return u.reduce(r.concat, arguments);
    };

    u.first = function(coll) {
        return coll[0];
    };

    u.last = function(coll) {
        return coll[coll.length - 1];
    };

    u.butlast = function(coll) {
        return r.take(coll.length - 1, coll);
    };

    u.rest = function(coll) {
        return r.drop(1, coll);
    };

    u.mapcat = function(f, coll) {
        return r.apply(u.concat, r.map(f, coll));
    };

    u.apply = function(f) {
        return r.apply(f, r.concat(
                    r.slice(1, arguments.length - 1, arguments), 
                    u.last(arguments)));
    };

    u.array = function() {
        return r.map(r.identity, arguments);
    };

    u.partition = function(n, step, coll) {
        if (coll === undefined) {
            return u.partition(n, n, step);
        }
        var result = [];
        while (coll.length >= n) {
            result.push(r.take(n, coll));
            coll = r.drop(step, coll);
        }
        return result;
    };

    u.reduce = function(f, coll) {
        return r.reduce(f, coll[0], u.rest(coll));
    };

    return u;
});

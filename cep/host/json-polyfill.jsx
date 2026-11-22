// JSON Polyfill for After Effects (which doesn't have JSON built-in)
if (typeof JSON === 'undefined') {
    JSON = {};

    JSON.parse = function(str) {
        try {
            return eval('(' + str + ')');
        } catch (e) {
            throw new Error('Invalid JSON: ' + e.message);
        }
    };

    JSON.stringify = function(obj, replacer, space) {
        var type = typeof obj;
        if (type === 'undefined' || type === 'function') {
            return undefined;
        }
        if (type === 'number' || type === 'boolean' || obj === null) {
            return String(obj);
        }
        if (type === 'string') {
            return '"' + obj.replace(/[\\"]/g, '\\$&').replace(/[\x00-\x1f]/g, function (c) {
                if (c === '\n') { return '\\n'; }
                if (c === '\r') { return '\\r'; }
                if (c === '\t') { return '\\t'; }
                return '\\u00' + (c.charCodeAt(0) < 16 ? '0' : '') + c.charCodeAt(0).toString(16);
            }) + '"';
        }
        if (obj instanceof Array) {
            var arr = [];
            for (var i = 0; i < obj.length; i++) {
                arr.push(JSON.stringify(obj[i], replacer, space));
            }
            return '[' + arr.join(',') + ']';
        }
        if (type === 'object') {
            var pairs = [];
            for (var key in obj) {
                if (obj.hasOwnProperty(key)) {
                    var val = JSON.stringify(obj[key], replacer, space);
                    if (val !== undefined) {
                        pairs.push('"' + key + '":' + val);
                    }
                }
            }
            return '{' + pairs.join(',') + '}';
        }
        return undefined;
    };
}

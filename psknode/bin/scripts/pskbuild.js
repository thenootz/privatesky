var fs = require("fs");
var path = require("path");
var browserify = require('browserify');

var args = process.argv.slice(2);
var externalTarget = process.argv[3];
//check if fil exists and if it is a directory
let skipShims = false;

if(externalTarget){
    if(externalTarget.indexOf("quick") != -1){
        skipShims = true;
    } else {
        var copyToExternalTarget = fs.existsSync(externalTarget) && fs.lstatSync(externalTarget).isDirectory();
        if(!copyToExternalTarget){
            console.error("ERROR", externalTarget, "is not accesible!" )
        }
    }

}

let skipList = skipShims ? ["webshims", "reactClient", "httpinteract","pskclient"] : [];

const depsNameProp = "deps";
const inputArg = "input";
const outputArg = "output";

var commandOptions = {
    input: path.join(process.cwd(), "builds", "tmp"),
    output: path.join(process.cwd(), "psknode", "bundles")
};

var modulesPath = [path.resolve(process.cwd(), "modules"), path.resolve(process.cwd(), "libraries")];

//TODO: maybe we should put here all the neccessary modules and the xtras on build,json ?!
var defaultMap = {
    webshims: "",
    pskruntime: "",
    psknode: "",
    pskclient: ""
}

var externals = {
    pskruntime: "webshims"
}

var mapJson = {};

function concatDependencyMaps(d1, d2) {
    if (!d1 || d1.length == 0) return d2;
    if (!d2 || d2.length == 0) return d1;

    let d3Arr = splitStrToArray(d2);
    for(let i=0; i<d3Arr.length; i++){
        if(d1.indexOf(d3Arr[i])!==-1){
            //removing duplicates deps from map
            d2 = d2.replace(new RegExp("[, ]*("+d3Arr[i]+")\\b"), "");
        }
    }
    return (d1+","+d2).replace(/(,+(\s+,+)+)|,+/g, ',');
}

function detectAlias(str){
    var a = str.trim().split(/\s*:\s*/);
    var res = {};
    res.module = a[0].trim();
    if(a[1]){
        res.alias = a[1].trim();
    } else{
        res.alias = res.module;
    }
    return res;
}

function doBrowserify(targetName, src, dest, opt, externalModules, exportsModules) {
    expected++;
    function scanExports(callback) {
        var stream = require("stream");
        var writable = new stream.Writable({
            write: function (chunk, encoding, next) {
                //ignore
                next();
            }
        });

        var package = browserify(src, opt);
        var mapForExpose = {};

        exportsModules.map(function (item) {
            var i = detectAlias(item);
            mapForExpose[i.module] = i;
        })

        package.on('file', function (file, id, parent) {

            var i = mapForExpose[id];
            //console.log(file, id, i);
            if (i && i.module == id) {
                //console.log("Found entry", file, "for", id);
                mapForExpose[id] = file;
                mapForExpose[i.alias] = file;
            }
        })
        package.bundle().pipe(writable).on("finish", function (err, res) {
            //console.log(mapForExpose);
            callback(null, mapForExpose);
        });
    }

    function doWork(err, mapForExpose) {
        //console.log("Processing ", src, "into", dest, "\n" /*, JSON.stringify(mapForExpose, 2)*/);

        var package = browserify(src, opt);

        if (externalModules) {
            package.external(externalModules);
        }

        for (var v in mapForExpose) {
            //console.log("Expose:", v, mapForExpose[v]);
            package.require(mapForExpose[v], {
                expose: v
            });
        }
        //ensure dir struct exists
        try{
            fs.mkdirSync(path.dirname(dest), {recursive:true});
        }catch(err){
            if(err.code !== "EEXIST"){
                console.log(err);
            }
        }

        /** Code for extracting source maps from bundles and writing them on disk **/

        const {Transform} = require('stream');

        function SourceMapExtractor() {
            Transform.call(this);
        }

        const util = require('util');
        util.inherits(SourceMapExtractor, Transform);

        SourceMapExtractor.prototype._transform = function (chunk, encoding, callback) {
            const data = chunk.toString();
            let sourceMapIndex = data.indexOf('//# sourceMappingURL');

            if (sourceMapIndex !== -1) {
                // finding source map location in bundle, it assumes a chunk will contain the entire source map
                const separatorPos = data.indexOf(',') + 1;
                const encodedSourceMap = data.substring(separatorPos);

                // decoding source map from base64 and parsing it as JSON
                const decodedSourceMap = Buffer.from(encodedSourceMap, 'base64').toString('utf8');
                const sourceMapAsObject = JSON.parse(decodedSourceMap);

                // source map is relative to PrivateSky root when building so it must specify a path back to it
                // relative to the folder where it will be written to
                sourceMapAsObject.sourceRoot = path.relative(path.dirname(dest), process.cwd());
                const sourceMapFileName = path.basename(dest) + '.map';

                // replace the source map data with the name of the file inside the bundle
                // this is how source map standard has support for external source maps
                this.push(`\n//# sourceMappingURL=${sourceMapFileName}`);

                // relative path from where source map will be written to PrivateSky root folder
                const pathToWriteSourceMapTo = path.join(path.dirname(dest), sourceMapFileName);

                // writing source map to the same folder as the bundle
                fs.writeFile(pathToWriteSourceMapTo, JSON.stringify(sourceMapAsObject), (err) => {
                    if (err) {
                        console.error('Error writing the source map file', err);
                    }
                });
            } else {
                // no source map was found in this chunk, passing it further as is
                this.push(chunk);
            }

            callback()
        };


        /** Generating bundles and writing them to disk **/

        const sourceMapExtractor = new SourceMapExtractor();
        const out = fs.createWriteStream(dest);
        package.bundle().pipe(sourceMapExtractor).pipe(out);
        endCallback(targetName);

        if (externalTarget && copyToExternalTarget) {
            ((dest) => {
                out.on('finish', () => {
                    copyToExternalDirectory(dest);
                });
            })(dest);
        }


    }

    scanExports(doWork);

}

function buildDependencyMap(targetName, configProperty, output) {
    var cfg = targets[targetName][depsNameProp];
    var autoLoad = configProperty.autoLoad || false;
    var result = `global.${targetName}LoadModules = function(){ \n`;
    splitStrToArray(cfg).map(function (item) {
        var ia = detectAlias(item);
        var line = `\t$$.__runtimeModules["${ia.alias}"] = require("${ia.module}");\n`;

        result += line;
    });
    result += `}\nif (${autoLoad}) {\n\t${targetName}LoadModules();\n}; \nglobal.` + `${targetName}Require = require;\n` +
    `if (typeof $$ !== "undefined") {            
    $$.requireBundle("${targetName}");
};

require('source-map-support').install({});
`;

    //ensure dir struct exists
    try{
        fs.mkdirSync(path.dirname(output), {recursive:true});
    }catch(err){
        if(err.code !== "EEXIST"){
            console.log(err);
        }
    }


    fs.writeFileSync(output, result);
}

function constructOptions(targetName, opts){
    var options = {
        paths : modulesPath,
        fullPaths : true,
        bundleExternal: false,
        debug: true,
        externalRequireName : targetName+"Require"
    };

    if(typeof opts == "undefined"){
        options.bare = true;
    }else{
        for(var prop in opts){
            if(prop != depsNameProp){
                options[prop] = opts[prop];
            }
        }
    }
    return options;
}

function splitStrToArray(str){
    return (typeof str === 'string' || str instanceof String) ? str.split(/\s*,\s*/) : [];
}

var counter = 0;
var expected = 0;
function endCallback(str){
    counter++;
    console.log(str, "done");
    if(counter == expected) {
        console.log("Finished rebuilding");
    }
}
var external_counter = 0
function copyToExternalDirectory(src){
    var filename = path.basename(src);
    var dest = path.join(externalTarget,filename);
    var writableStream = fs.createWriteStream(dest)
    fs.createReadStream(src).pipe(writableStream);
    writableStream.on("finish",function(){
        external_counter++;
        if(external_counter === expected){
            console.log("All targets were successfully copied to",externalTarget);
        }
    });

}

function buildTarget(targetName){
    if(skipList.indexOf(targetName) != -1) return;
    console.log("Building target", targetName);

    buildDependencyMap(targetName, constructOptions(targetName, targets[targetName]), path.join(commandOptions.input, targetName+"_intermediar.js"));

    var overrideFile = path.join(commandOptions.input, targetName+".js");
    var overrideFileExists = fs.existsSync(overrideFile);
	
    doBrowserify(targetName,
        path.join(commandOptions.input, targetName + (overrideFileExists ? "" : "_intermediar")+".js"),
        path.join(commandOptions.output, targetName + ".js"),
        constructOptions(targetName, targets[targetName]),
        externals[targetName] && targets[externals[targetName]] ? splitStrToArray(targets[externals[targetName]][depsNameProp]) : null,
        splitStrToArray(targets[targetName][depsNameProp]));
}


//---------------------- Processing

if (args.length == 0) {
    console.log("pskbuild is used to build the runtime or the code for running a privatesky domain");
    console.log(`Usage: pskbuild <projectmap> [--${inputArg}=<inputPath> --${outputArg}=<outputPath>]`);
    console.log("projectmap is a JSON file that contains the lists of targets and their dependencies that will be built.");
    console.log("Using default configuration, normally used for building a runtime");
} else {
    var projectMap = fs.readFileSync(args[0]);
    if (!projectMap) {
        console.log("Invalid project map file:", args[0]);
    }else{
        console.log("Found project map", args[0]);
        mapJson = JSON.parse(projectMap);
    }
}

var targets = {};

console.log("Reading targets and their dependencies list...");
for(var prop in mapJson){
    var target = mapJson[prop];
    if(typeof target === 'string' || target instanceof String){
        var t = {};
        t[depsNameProp] = concatDependencyMaps(defaultMap[prop], mapJson[prop]);
        targets[prop] = t;
    }else{
        if(target instanceof Object && !Array.isArray(target)){
            var t = {};
            for(var p in mapJson[prop]){
                if(p==depsNameProp){
                    t[p] = concatDependencyMaps(defaultMap[prop], mapJson[prop][p]);
                }else{
                    t[p] = mapJson[prop][p];
                }
            }
            targets[prop] = t;
        }else{
            throw new Error(`Wrong format of target <${prop}> found in project map file!`);
        }
    }
    //console.log("Identified and prepared target", prop, targets[prop]);
}

console.log("Reading other command arguments if any...");
var i=1;
var knowArgs = [inputArg, outputArg];
while(i<args.length){
    var found = false;
    for(var j=0; j<knowArgs.length; j++){
        if(args[i].indexOf("--"+knowArgs[j]+"=")!=-1){
            found = knowArgs[j];
        }
    }
    if(found){
        var value = args[i];
        //striping --name= from arg
        value=value.replace("--", "").replace(found+"=", "");
        commandOptions[found] = path.join(process.cwd(), value);
        console.log(`Command option "${found}" set`, commandOptions[found]);
    }else
        if(externalTarget !== args[i]) {
        console.log("Ignored argument", args[i], "reason: unknown");
    }
    i++;
}

console.log("Starts rebuilding");

for(var target in targets){
    buildTarget(target);
}

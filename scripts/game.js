require(["ramda", "webgl_helpers", "functional_utils"], function(r, w, fun) {
    "use strict";

    //Constants
    var minSegLen = 0.025;
    var maxSegLen = 0.15;
    var minGroundHeight = 0.1;
    var maxGroundHeight = 0.45;
    var flatChance = 0.6;
    var gravity = [0, -0.2];
    var ballRadius = 0.01;
    var ballSectors = 16;
    var bounceLoss = 0.3;
    var canvas = document.getElementById("canvas");
    var xpx = canvas.clientWidth;
    var ypx = canvas.clientHeight;
    var shotStrength = 1.5;
    var holeFlatWidth = 0.01;
    var halfHoleWidth = 0.02;
    var holeWidth = holeFlatWidth + halfHoleWidth;
    var holeDepth = 0.05;
    var holePattern = [
        [-holeFlatWidth - halfHoleWidth, 0], [-halfHoleWidth, 0],
        [-halfHoleWidth, -holeDepth], [halfHoleWidth, -holeDepth],
        [halfHoleWidth, 0], [holeFlatWidth + halfHoleWidth, 0]];
    var gameSpeed = 0.0022;
    var particleSize = 8;
    var numParticles = 150;
    var numTrails = 10;
    var explosionSpeed = 0.1;
    var numExplosions = 5;
    var velocityThreshold = 0.02;
    var toGroundThreshold = 0.002;
    //These are in milliseconds.
    var explosionLife = 1100;
    var explosionInterval = 200;
    var newHoleDelay = 200; //after explosions

    //State
    var program;
    var gl;
    var ballPosition;
    var startingPosition;
    var ballVelocity = [0, 0];
    var lastTimestamp;
    var currentLandscape;
    var ballStill = true;
    var shooting = false;
    var celebrating = false;
    var aimStartPos;
    var aimEndPos;
    var bottomOfHole;
    var shots = 0;
    var completed = 0;
    var explosions = [];
    var trailTimer = 0;
    var trailTimerLimit = 20;

    var translationMat = function (translation) {
        return [[1, 0, translation[0]],
               [0, 1, translation[1]],
               [0, 0, 1]];
    };

    var rotationMat = function (angle) {
        var c = Math.cos(angle);
        var s = Math.sin(angle);
        return [[c, -s, 0],
               [s, c, 0],
               [0, 0, 1]];
    };

    var scaleMat = function (scale) {
        if (typeof scale === "number") {
            scale = [scale, scale];
        }
        return [[scale[0], 0, 0],
               [0, scale[1], 0],
               [0, 0, 1]];
    };

    var transpose = function(matrix) {
        return fun.apply(fun.map, fun.array, matrix);
    };

    var matrixMul = function () {
        var mul2 = function(a, b) {
            var tb = transpose(b);
            var result = [];
            for (var i = 0; i < a.length; i++) {
                var row = a[i];
                for (var j = 0; j < tb.length; j++) {
                    var col = tb[j];
                    result.push(dot(row, col));
                }
            }
            return fun.partition(3, result);
        };
        return fun.reduce(mul2, arguments);
    };

    var rotateVec = function(v, angle) {
        var x = v[0];
        var y = v[1];
        return [x * Math.cos(angle) - y * Math.sin(angle),
               x * Math.sin(angle) + y * Math.cos(angle)];
    };

    var add = function() {
        return r.reduce(function (x, y) {return x + y;}, 0, arguments);
    };

    var sub = function() {
        var sub2 = function (x, y) {return x - y;};
        if (arguments.length < 2) {
            return r.reduce(sub2, 0, arguments);
        }
        return fun.reduce(sub2, arguments);
    };

    var mul = function() {
        return r.reduce(function (x, y) {return x * y;}, 1, arguments);
    };

    var scaleVec = function(s, v) {
        return r.map(r.multiply(s), v);
    };

    var vecAdd = function(u, v) {
        return fun.map(add, u, v);
    };

    var vecSub = function(u, v) {
        return fun.map(sub, u, v);
    };

    var magnitude = function(v) {
        var sq = function(x) {return x * x;};
        return Math.sqrt(r.apply(add, r.map(sq, v)));
    };

    var normalize = function(v) {
        return scaleVec(1 / magnitude(v), v);
    };

    var dot = function(u, v) {
        return r.apply(add, fun.map(mul, u, v));
    };

    var angleBetween = function(u, v) {
        return Math.acos(dot(normalize(u), normalize(v)));
    };

    var signedAngleBetween = function(u, v) {
        u = normalize(u);
        v = normalize(v);
        return Math.asin(u[0] * v[1] - u[1] * v[0]);
    };

    var linesIntersect = function(l1, l2) {
        var points = [l1[0], l2[0], l1[1], l2[1]];
        for (var i = 0; i < 4; i++) {
            var p = points[i];
            //These are the vectors to the 3 other points from p,
            //vo being to the point on the same line as p.
            var v1 = vecSub(points[(i + 1) % 4], p);
            var vo = vecSub(points[(i + 2) % 4], p);
            var v2 = vecSub(points[(i + 3) % 4], p);
            var angle12 = angleBetween(v1, v2);
            var angleo1 = angleBetween(vo, v1);
            var angleo2 = angleBetween(vo, v2);
            //The angle between v1 and v2 can not be smaller than the angle
            //between vo and v1 or vo and v2, because the vector vo (to the
            //point on the same line as p) has to be in the middle.
            if (angle12 < angleo1 || angle12 < angleo2) {
                return false;
            }
        }
        return true;
    };

    var rand = function(min, max) {
        if (max === undefined) {
            max = min;
            min = 0;
        }
        return min + Math.random() * (max - min);
    };

    var randInt = function(min, max) {
        return Math.floor(rand(min, max));
    };

    var chance = function(chance) {
        return rand(1) < chance ? true : false;
    };

    var randomPoint = function() {
        return [rand(minSegLen, maxSegLen),
               rand(minGroundHeight, maxGroundHeight)];
    };

    //flatChance === 1 means every second segment becomes flat.
    var insertFlatSegments = function(flatChance, points) {
        return fun.mapcat(
                function (p) {
                    return chance(flatChance) ? [p, [rand(minSegLen, maxSegLen), p[1]]] : [p];
                },
                points);
    };

    var epilocation = function(pos, ground) {
        var x = pos[0];
        var line = function findLine(i) {
            if (ground[i][0] > x) {
                return [ground[i - 1], ground[i]];
            }
            return findLine(i + 1);
        }(0);
        var p = line[0];
        var q = line[1];
        var y = p[1] + (x - p[0]) / (q[0] - p[0]) * (q[1] - p[1]);
        return [x, y];
    };

    var distanceToGround = function(pos, ground) {
        return magnitude(vecSub(pos, epilocation(pos, ground)));
    };

    var landscape = function() {
        var points = insertFlatSegments(flatChance,
                fun.cons([0, 0.4],
                    fun.repeatedly(1 / minSegLen + 1, randomPoint)));
        var lastPoint = points[0];
        return r.map(
                function(p) {
                    var newX = p[0] + lastPoint[0];
                    var newP = r.update(0, newX, p);
                    lastPoint = newP;
                    return newP;
                },
                points);
    };

    var toGlslFormat = function(matrix) {
        return r.flatten(transpose(matrix));
    };

    var drawGraphics = function(vertices, mode, color, transformation) {
        transformation = transformation || {};
        var translation = transformation.translation || [0, 0];
        var rotation = transformation.rotation || 0;
        var scale = transformation.scale || 1;
        var matrix = matrixMul(
                translationMat(translation),
                rotationMat(rotation),
                scaleMat(scale));

        var matrixLoc = gl.getUniformLocation(program, "u_matrix");
        gl.uniformMatrix3fv(matrixLoc, gl.FALSE, toGlslFormat(matrix));
        var colorLoc = gl.getUniformLocation(program, "u_color");
        gl.uniform3fv(colorLoc, color);
        var particleSizeLoc = gl.getUniformLocation(program, "u_pointSize");
        gl.uniform1f(particleSizeLoc, particleSize);
        var useTextureLoc = gl.getUniformLocation(program, "u_useTexture");
        gl.uniform1i(useTextureLoc, mode === gl.POINTS ? 1 : 0);

        var positionLoc = gl.getAttribLocation(program, "a_position");
        var buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices),
                gl.STATIC_DRAW);
        gl.enableVertexAttribArray(positionLoc);
        gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(mode, 0, r.length(vertices) / 2);
    };

    var drawBall = function() {
        var pointOnCircle = function(angle) {
            return [Math.cos(angle), Math.sin(angle)];
        };

        var ballPoints = r.map(pointOnCircle,
                r.map(function (factor) {return 2 * Math.PI / ballSectors * factor;},
                    r.range(0, ballSectors)));

        ballPoints = r.map(r.partial(scaleVec, ballRadius), ballPoints);

        drawGraphics(r.flatten(ballPoints), gl.TRIANGLE_FAN, [1, 1, 1], {
            translation: ballPosition});
    };

    var drawGround = function() {
        var pointsForDrawing = function(pair) {
            var p = pair[0];
            var q = pair[1]
                var bp = [p[0], 0];
            var bq = [q[0], 0];
            return [p, q, bp,
                   bq, bp, q];
        };

        var pairs = fun.partition(2, 1, currentLandscape);
        var vertices = r.flatten(r.map(pointsForDrawing, pairs));
        drawGraphics(vertices, gl.TRIANGLES, [0, 0.9, 0]);
    };

    var drawAimLine = function() {
        var aimEndPosVector = vecSub(aimEndPos, aimStartPos);
        var line = [ballPosition, vecAdd(ballPosition, aimEndPosVector)];
        drawGraphics(r.flatten(line), gl.LINES, [1, 1, 0]);
    };

    var drawFlag = function() {
        var w = 0.004;
        var h = 0.09;
        var fh = 0.03;
        var fl = 0.04;
        var pole = [[-w, h], [w, h], [-w, 0],
            [w, h], [-w, 0], [w, 0]];
        var flag = [[w, h], [w + fl, h - fh / 2], [w, h - fh]];
        var transformation = {translation: bottomOfHole};
        drawGraphics(r.flatten(pole), gl.TRIANGLES, [0.8, 0.4, 0.2],
                transformation);
        drawGraphics(r.flatten(flag), gl.TRIANGLES, [1, 0, 0],
                transformation);
    };

    var drawExplosion = function(exp) {
        var pos = function(p) {
            return p.position;
        };
        var transformation = {translation: exp.position};
        drawGraphics(r.flatten(r.map(pos, exp.particles)), gl.POINTS, [1, 1, 0],
                transformation);
    };

    var drawScene = function() {
        gl.clearColor(0.5, 0.5, 1.0, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        drawGround();
        drawFlag();
        if (shooting) {
            drawAimLine();
        };
        drawBall();
        explosions.forEach(drawExplosion);
    };

    var updateScore = function() {
        document.getElementById("hole").innerHTML = (completed + 1);
        document.getElementById("shots").innerHTML = shots;
        document.getElementById("per-hole").innerHTML = shots / (completed + 1);
    };

    var setupHole = function() {
        var land = landscape();
        var pointsNeeded = r.length(r.takeWhile(function (p) {return p[0] < 1;},
                    land)) + 1;
        land = r.take(pointsNeeded, land);

        startingPosition = ballPosition = fun.updateNumber(1, 0.001,
                epilocation([0.1, 1], land));

        var holePos = epilocation([rand(0.7, 0.9), 1], land);
        bottomOfHole = fun.updateNumber(1, -holeDepth, holePos);
        var before = [];
        var after = land;
        var hole = r.map(r.partial(vecAdd, holePos), holePattern);
        currentLandscape = function insertHole(holeX) {
            if (after[0][0] > holeX) {
                before = function fixBefore(before) {
                    if (fun.last(before)[0] + holeWidth > holeX) {
                        return fixBefore(fun.butlast(before));
                    }
                    return before;
                }(before);

                after = function fixAfter(after) {

                    if (fun.first(after)[0] - holeWidth < holeX) {
                        return fixAfter(fun.rest(after));
                    }
                    return after;
                }(after);

                return fun.concat(before, hole, after);

            } else {
                before.push(after[0]);
                after = fun.rest(after);
            }
            return insertHole(holeX);
        }(holePos[0]);
    };

    var mouseLocation = function(e) {
        return [e.layerX / xpx, 1 - e.layerY / ypx]
    };

    var beginShooting = function(e) {
        if (ballStill && !celebrating) {
            shooting = true;
            aimStartPos = mouseLocation(e);
        };
    };

    var shoot = function(e) {
        if (shooting) {
            shooting = false;
            ballStill = false;
            var loc = mouseLocation(e);
            ballVelocity = scaleVec(shotStrength, vecSub(loc, aimStartPos));
            shots += 1;
            updateScore();
        };
    };

    var aim = function(e) {
        aimEndPos = mouseLocation(e);
    };

    var inHole = function(ball, hole) {
        return magnitude(vecSub(ball, hole)) <= halfHoleWidth;
    };

    var outOfBounds = function(pos) {
        var x = pos[0];
        return x <= 0 || x >= 1;
    };

    var addDeltaVector = function(delta, addition, to) {
        return vecAdd(scaleVec(delta, addition), to);
    };

    var bounce = function(delta) {
        if (outOfBounds(ballPosition)) {
            ballPosition = startingPosition;
            ballVelocity = [0, 0];
            ballStill = true;
            return;
        };

        var findIntersectingSegment = function(line) {
            return fun.first(r.filter(r.partial(linesIntersect, line),
                        fun.partition(2, 1, currentLandscape)));
        };

        var addDeltaVectorPrim = r.partial(addDeltaVector, delta);

        ballVelocity = addDeltaVectorPrim(gravity, ballVelocity);

        var calculateVelocity = function(velocity) {
            var toGround = distanceToGround(ballPosition, currentLandscape);
            if (magnitude(velocity) < velocityThreshold &&
                    toGround < toGroundThreshold) {
                ballStill = true;
                return [0, 0];
            }

            var newPosition = addDeltaVectorPrim(velocity, ballPosition);

            var line = findIntersectingSegment([ballPosition, newPosition]);
            if (line) {
                var surface = vecSub(line[1], line[0]);
                var normal = rotateVec(surface, Math.PI / 2);
                var reflectedVelocity = scaleVec(-1, velocity);
                var angle = signedAngleBetween(reflectedVelocity, normal);

                velocity = scaleVec(1 - bounceLoss,
                        rotateVec(reflectedVelocity, 2 * angle));
                return calculateVelocity(velocity);
            }
            return velocity;
        };

        ballVelocity = calculateVelocity(ballVelocity);
        ballPosition = addDeltaVectorPrim(ballVelocity, ballPosition);
    };

    var createParticle = function() {
        var rand1 = r.partial(rand, -1, 1);
        return {position: scaleVec(0.01, [rand1(), rand1()]),
            //Normalize a 3D vector to make the explosion look 3D
            velocity: fun.butlast(normalize([rand1(), rand1(), rand1()]))};
    };

    var createExplosion = function(pos) {
        return {position: pos,
            particles: fun.repeatedly(numParticles, createParticle),
            explosionTime: 0,
            timeToLive: explosionLife};
    };

    var updateParticle = function(delta, explosionTime, p) {
        //The speed of particles should decrease with time after explosion.
        var speed = explosionSpeed / (Math.pow(explosionTime / 500 , 2) + 1);
        //Multiply by game speed to make gravity and velocity calculations
        //similar to the ball's.
        delta *= gameSpeed;
        //Divide gravity increase by speed to counteract
        //the slowing down of gravity.
        //Repetition (verbosity) below is an optimization.
        p.velocity[1] += delta / speed * gravity[1] / 10;
        p.position[0] += delta * speed * p.velocity[0];
        p.position[1] += delta * speed * p.velocity[1];
        return p;
    };

    var spawnTrails = function(particles) {
        var copy = function(p) {
            return {position: r.map(r.identity, p.position),
                velocity: [0, 0]};
        };

        particles = fun.concat(particles,
                r.map(copy, r.slice(0, numParticles, particles)));

        if (particles.length > numParticles * numTrails) {
            particles = fun.concat(
                    r.slice(0, numParticles, particles),
                    r.slice(2 * numParticles, (2 + numTrails) * numParticles, particles));
        };
        return particles;
    };

    var updateExplosion = function(delta, exp) {
        //Explosions are completely removed after the celebration.
        if (exp.timeToLive <= 0) {
            exp.particles = [];
            return exp;
        };
        exp.timeToLive -= delta;
        exp.explosionTime += delta;
        if (trailTimer > trailTimerLimit) {
            exp.particles = spawnTrails(exp.particles);
        };
        exp.particles = r.map(
                r.partial(updateParticle, delta, exp.explosionTime),
                exp.particles);
        return exp;
    };

    var celebrate = function() {
        celebrating = true;
        var duration = (numExplosions - 1) * explosionInterval +
            explosionLife + newHoleDelay;
        var celebrationTime = 0;
        var lastUpdate = performance.now();
        var spawnedExplosions = 0;

        var runCelebration = function(now) {
            var delta = now - lastUpdate;
            lastUpdate = now;

            celebrationTime += delta;
            if (celebrationTime > explosionInterval * spawnedExplosions) {
                var pos = [0.7 + rand(-0.2, 0.2),
                    0.8 + rand(-0.1, 0.1)];
                if (spawnedExplosions < numExplosions) {
                    explosions.push(createExplosion(pos));
                    spawnedExplosions += 1;
                }
            };

            trailTimer += delta;
            explosions.forEach(r.partial(updateExplosion, delta));
            if (trailTimer > trailTimerLimit) {
                trailTimer -= trailTimerLimit;
            }

            drawScene();

            if (celebrationTime > duration) {
                celebrating = false;
                explosions = [];
                setupHole();
                window.requestAnimationFrame(mainLoop);
            } else {
                window.requestAnimationFrame(runCelebration);
            }
        };

        window.requestAnimationFrame(runCelebration);
    };

    var logic = function(delta) {
        delta *= gameSpeed;

        if (!ballStill) {
            bounce(delta);
        }
        if (ballStill && inHole(ballPosition, bottomOfHole)) {
            completed += 1;
            celebrate();
            updateScore();
        }
    };

    var gaussian = function(x) {
        var c = 0.3;
        return Math.exp(-x * x / (2 * c * c));
    };

    var gaussianTexture = function(size) {
        var result = [];
        var mid = size/2 - 0.5;
        mid = [mid, mid];
        var distToEdge = magnitude(mid);
        var color = function(alpha) {
            alpha *= 0.1;
            var timesAlpha = function (x) {
                return Math.floor(x * alpha);
            };
            return [255, 100 + timesAlpha(155),
                   timesAlpha(255 * alpha), timesAlpha(255)];
        };
        for (var x = 0; x < size; x++) {
            for (var y = 0; y < size; y++) {
                result.push(color(gaussian(
                                magnitude(vecSub([x, y], mid)) / distToEdge)));
            }
        }
        return result;
    };

    var makeParticleTexture = function(gl) {
        var texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, particleSize, particleSize, 0,
                gl.RGBA, gl.UNSIGNED_BYTE,
                new Uint8Array(r.flatten(gaussianTexture(particleSize))));
        gl.generateMipmap(gl.TEXTURE_2D);
    };

    var mainLoop = function(now) {
        var delta = now - lastTimestamp;
        lastTimestamp = now;

        if (celebrating) {
            return;
        }

        logic(delta);
        drawScene();
        window.requestAnimationFrame(mainLoop);
    };

    var main = function() {
        canvas.onmousemove = aim;
        canvas.onmousedown = beginShooting;
        canvas.onmouseup = shoot;

        gl = canvas.getContext("webgl");
        program = w.programFromScripts(gl, "vshader", "fshader");
        gl.useProgram(program);
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        makeParticleTexture(gl);

        lastTimestamp = performance.now();
        setupHole();

        window.requestAnimationFrame(mainLoop);
    };

    main();
});

//@ts-check
/*
  Copyright: (c) 2016-2020, St-One Ltda., Guilherme Francescon Cittolin <guilherme@st-one.io>
  GNU General Public License v3.0+ (see LICENSE or https://www.gnu.org/licenses/gpl-3.0.txt)
*/

let nodes5;
try {
    nodes5 = require('@protocols/nodes5');
} catch (e) { }

function nrInputShim(node, fn) {
    node.on('input', function (msg, send, done) {
        send = send || node.send;
        done = done || (err => err && node.error(err, msg));
        fn(msg, send, done);
    });
}

/**
 * Compares values for equality, includes special handling for arrays. Fixes #33
 * @param {number|string|Array|Date} a
 * @param {number|string|Array|Date} b 
 */
function equals(a, b) {
    if (a === b) return true;
    if (a == null || b == null) return false;
    if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length != b.length) return false;

        for (var i = 0; i < a.length; ++i) {
            if (a[i] !== b[i]) return false;
        }
        return true;
    }
    return false;
}

var MIN_CYCLE_TIME = 1000;

module.exports = function (RED) {
    RED.httpAdmin.get('/__node-red-contrib-s5/discover/serialports', RED.auth.needsPermission('s5.discover'), function (req, res) {
        if (!nodes5) return res.status(500).end(); 

        nodes5.S5PLC.listPorts().then(function (serialports) {
            res.json(serialports).end();
        }).catch(() => {
            res.status(500).end();
        });
    });

    // ---------- s5 plc ----------

    function createTranslationTable(vars) {
        var res = {};

        vars.forEach(function (elm) {
            if (!elm.name || !elm.addr) {
                //skip incomplete entries
                return;
            }
            res[elm.name] = elm.addr;
        });

        return res;
    }

    function generateStatus(status, val) {
        var obj;

        if (typeof val != 'string' && typeof val != 'number' && typeof val != 'boolean') {
            val = RED._('s5.plc.status.online');
        }
        switch (status) {
            case 'online':
                obj = {
                    fill: 'green',
                    shape: 'dot',
                    text: val.toString()
                };
                break;
            case 'offline':
                obj = {
                    fill: 'red',
                    shape: 'dot',
                    text: RED._('s5.plc.status.offline')
                };
                break;
            case 'connecting':
                obj = {
                    fill: 'yellow',
                    shape: 'dot',
                    text: RED._('s5.plc.status.connecting')
                };
                break;
            default:
                obj = {
                    fill: 'grey',
                    shape: 'dot',
                    text: RED._('s5.plc.status.unknown')
                };
        }
        return obj;
    }

    function S5Plc(config) {
        const node = this;
        let oldValues = {};
        let readInProgress = false;
        let readDeferred = 0;
        let currentCycleTime = config.cycletime;
        let portPath = config.serialport;
        let _cycleInterval;
        let _reconnectTimeout = null;
        let connected = false;
        let closing = false;
        let status;
        /** @type {import('@protocols/nodes5').S5PLC} */
        let plcs5 = null;
        let addressGroup = null;
        
        RED.nodes.createNode(this, config);

        if (!portPath) {
            manageStatus('offline');
            node.error('Undefined port path!');
            return;
        }

        //avoids warnings when we have a lot of S5 In nodes
        this.setMaxListeners(0);
        function manageStatus(newStatus) {
            if (status == newStatus) return;

            status = newStatus;
            node.emit('__STATUS__', status);
        }

        function doCycle() {
            if (!readInProgress && connected) {
                readInProgress = true;
                addressGroup.readAllItems()
                .then(cycleCallback)
                .catch(e => {
                    node.error(e, {});
                    readInProgress = false;
                });
            } else {
                readDeferred++;
            }
        }

        function cycleCallback(values) {
            readInProgress = false;

            if (readDeferred && connected) {
                doCycle();
                readDeferred = 0;
            }

            manageStatus('online');

            var changed = false;
            node.emit('__ALL__', values);
            Object.keys(values).forEach(function (key) {
                if (!equals(oldValues[key], values[key])) {
                    changed = true;
                    node.emit(key, values[key]);
                    node.emit('__CHANGED__', {
                        key: key,
                        value: values[key]
                    });
                    oldValues[key] = values[key];
                }
            });
            if (changed) node.emit('__ALL_CHANGED__', values);
        }

        function updateCycleTime(interval) {
            let time = parseInt(interval);

            if (isNaN(time) || time < 0) {
                node.error(RED._("s5.plc.error.invalidtimeinterval", { interval: interval }));
                return false
            }

            clearInterval(_cycleInterval);

            // don't set a new timer if value is zero
            if (!time) return false;

            if (time < MIN_CYCLE_TIME) {
                node.warn(RED._("s5.plc.info.cycletimetooshort", { min: MIN_CYCLE_TIME }));
                time = MIN_CYCLE_TIME;
            } 

            currentCycleTime = time;
            _cycleInterval = setInterval(doCycle, time);

            return true;
        }

        node.updateCycleTime = updateCycleTime;
        node.getStatus = function getStatus() {
            return status;
        }

        /**
         * Destroys the plcs5 connection
         */
        function disconnect(done) {

            connected = false;
            clearInterval(_cycleInterval);
            manageStatus('offline');

            if (plcs5) {
                plcs5.removeListener('connect', onConnect);
                plcs5.removeListener('close', onDisconnect);
                plcs5.removeListener('error', onError);
                plcs5.on('error', err => { //safety net to catch post-close errors
                    node.error(err);
                });
                if (done) {
                    if (plcs5.closed) {
                        process.nextTick(() => done());
                    } else {
                        plcs5.on('close', done);
                    }
                }
                plcs5.close();
                plcs5 = null;
            } else {
                if (done) done();
            }
        }
        
        function connect() {
            clearTimeout(_reconnectTimeout);

            if (!nodes5) return node.error('Missing "@protocols/nodes5" dependency, avaliable only on the ST-One hardware. Please contact us at "st-one.io" more information.') 
            
            disconnect(() => {
                manageStatus('connecting');
                
                plcs5 = new nodes5.S5PLC(portPath, { timeout: currentCycleTime });
                plcs5.on('connect', onConnect);
                plcs5.on('close', onDisconnect);
                plcs5.on('error', onError);
                plcs5.connect();
            });
        }

        function onConnect() {
            clearTimeout(_reconnectTimeout);

            readInProgress = false;
            readDeferred = 0;
            connected = true;
            manageStatus('online');

            addressGroup = new nodes5.s5itemGroup(plcs5);

            let _vars = createTranslationTable(config.vartable);

            addressGroup.setTranslationCB(k => _vars[k]);
            let varKeys = Object.keys(_vars);

            if (!varKeys || !varKeys.length) {
                node.warn(RED._("s5.plc.info.novars"));
            } else {
                addressGroup.addItems(varKeys);
                updateCycleTime(currentCycleTime);
            }
        }

        function onDisconnect() {

            connected = false;
            clearInterval(_cycleInterval);
            manageStatus('offline');

            if (!closing) {
                clearTimeout(_reconnectTimeout);
                _reconnectTimeout = setTimeout(connect, 5000);
            }
        }

        function onError(e) {
            manageStatus('offline');
            node.error(e instanceof Error ? String(e) : JSON.stringify(e) );
            //disconnect(); //should disconnect automatically
        }

        node.on('close', done => {
            closing = true;
            clearInterval(_cycleInterval);
            clearTimeout(_reconnectTimeout);     

            disconnect(done);
        });
        
        connect();
    }
    RED.nodes.registerType('s5 plc', S5Plc);

    // <Begin> --- S5 In
    function S5In(config) {
        RED.nodes.createNode(this, config);
        let statusVal;
        let node = this

        let s5plc = RED.nodes.getNode(config.plc);

        if (!s5plc) {
            node.error(RED._("s5.error.missingconfig"));
            return;
        }

        function sendMsg(data, key, status) {
            if (key === undefined) key = '';
            if (data instanceof Date) data = data.getTime();
            var msg = {
                payload: data,
                topic: key
            };
            statusVal = status !== undefined ? status : data;
            node.send(msg);
            updateStatus(s5plc.getStatus())
        }
        
        function onChanged(variable) {
            sendMsg(variable.value, variable.key, null);
        }

        function onDataSplit(data) {
            Object.keys(data).forEach(function (key) {
                sendMsg(data[key], key, null);
            });
        }

        function onData(data) {
            sendMsg(data, config.mode == 'single' ? config.variable : '');
        }

        function onDataSelect(data) {
            onData(data[config.variable]);
        }

        function updateStatus(status) {
            node.status(generateStatus(status, statusVal));
        }
        
        s5plc.on('__STATUS__', updateStatus);
        updateStatus(s5plc.getStatus())

        if (config.diff) {
            switch (config.mode) {
                case 'all-split':
                    s5plc.on('__CHANGED__', onChanged);
                    break;
                case 'single':
                    s5plc.on(config.variable, onData);
                    break;
                case 'all':
                default:
                    s5plc.on('__ALL_CHANGED__', onData);
            }
        } else {
            switch (config.mode) {
                case 'all-split':
                    s5plc.on('__ALL__', onDataSplit);
                    break;
                case 'single':
                    s5plc.on('__ALL__', onDataSelect);
                    break;
                case 'all':
                default:
                    s5plc.on('__ALL__', onData);
            }
        }

        this.on('close', function (done) {
            s5plc.removeListener('__ALL__', onDataSelect);
            s5plc.removeListener('__ALL__', onDataSplit);
            s5plc.removeListener('__ALL__', onData);
            s5plc.removeListener('__ALL_CHANGED__', onData);
            s5plc.removeListener('__CHANGED__', onChanged);
            s5plc.removeListener('__STATUS__', updateStatus);
            s5plc.removeListener(config.variable, onData);
            done();
        });

    }

    RED.nodes.registerType('s5 in', S5In);
    // <End> --- S5 In

    // <Begin> --- S5 Control
    function S5Control(config) {
        let node = this;
        RED.nodes.createNode(this, config);

        let s5plc = RED.nodes.getNode(config.plc);

        if (!s5plc) {
            this.error(RED._("df1.error.missingconfig"));
            return;
        }

        function updateStatus(status) {
            node.status(generateStatus(status));
        }

        function onMessage(msg, send, done) {
            let func = config.function || msg.function;
            switch (func) {
                case 'cycletime':
                    s5plc.emit('__UPDATE_CYCLE__', {
                        msg: msg,
                        send: send,
                        done: done
                    });
                    break;
                case 'trigger':
                    s5plc.emit('__DO_CYCLE__');
                    send(msg);
                    done();
                    break;

                default:
                    this.error(RED._("s5.error.invalidcontrolfunction", { function: config.function }), msg);
            }
        }

        function onUpdateCycle(res) {
            let err = res.err;
            if (!err) {
                res.done(err);
            } else {
                res.send(res.msg);
                res.done();
            }
        }

        s5plc.on('__STATUS__', updateStatus);
        s5plc.on('__UPDATE_CYCLE_RES__', onUpdateCycle);

        s5plc.emit('__GET_STATUS__');

        nrInputShim(this, onMessage);

        this.on('close', function (done) {
            s5plc.removeListener('__STATUS__', updateStatus);
            s5plc.removeListener('__UPDATE_CYCLE_RES__', onUpdateCycle);
            done();
        });

    }
    RED.nodes.registerType("s5 control", S5Control);
    // <End> --- S5 Control
}

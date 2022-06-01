//@ts-check
/*
  Copyright: (c) 2016-2020, St-One Ltda., Guilherme Francescon Cittolin <guilherme@st-one.io>
  GNU General Public License v3.0+ (see LICENSE or https://www.gnu.org/licenses/gpl-3.0.txt)
*/

const Port = require('@protocols/nodes5').S5PLC
const nodes5 = require('@protocols/nodes5');

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
        Port.listPorts().then(function (serialports) {
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
        let oldValues = {};
        let readInProgress = false;
        let readDeferred = 0;
        let currentCycleTime = config.cycletime;
        let portPath = config.serialport;
        let _cycleInterval;
        let _reconnectTimeout = null;
        let connected = false;
        let status;
        let that = this;
        let plcs5 = null;
        let addressGroup = null;
        
        RED.nodes.createNode(this, config);

        //avoids warnings when we have a lot of S5 In nodes
        this.setMaxListeners(0);
        function manageStatus(newStatus) {
            if (status == newStatus) return;

            status = newStatus;
            that.emit('__STATUS__', status);
        }

        function doCycle() {
            if (!readInProgress && connected) {
                addressGroup.readAllItems().then(cycleCallback).catch(e => {
                    that.error(e, {});
                    readInProgress = false;
                });
                readInProgress = true;
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
            that.emit('__ALL__', values);
            Object.keys(values).forEach(function (key) {
                if (!equals(oldValues[key], values[key])) {
                    changed = true;
                    that.emit(key, values[key]);
                    that.emit('__CHANGED__', {
                        key: key,
                        value: values[key]
                    });
                    oldValues[key] = values[key];
                }
            });
            if (changed) that.emit('__ALL_CHANGED__', values);
        }

        function updateCycleTime(interval) {
            let time = parseInt(interval);

            if (isNaN(time) || time < 0) {
                that.error(RED._("s5.plc.error.invalidtimeinterval", { interval: interval }));
                return false
            }

            clearInterval(_cycleInterval);

            // don't set a new timer if value is zero
            if (!time) return false;

            if (time < MIN_CYCLE_TIME) {
                that.warn(RED._("s5.plc.info.cycletimetooshort", { min: MIN_CYCLE_TIME }));
                time = MIN_CYCLE_TIME;
            } 

            currentCycleTime = time;
            _cycleInterval = setInterval(doCycle, time);

            return true;
        }

        function removeListeners() {
             if (plcs5 !== null) {
                that.removeListener('connected',onConnect)      
                that.removeListener('disconnected',onDisconnect) 
                that.removeListener('error',onError) 
                that.removeListener('timeout',onTimeout)           

                plcs5.removeListener('connected', onConnect);
                plcs5.removeListener('disconnected', onDisconnect);
                plcs5.removeListener('error', onError);
                plcs5.removeListener('timeout', onTimeout);
             }
        }

        /**
         * Destroys the plcs5 connection
         * @param {Boolean} [reconnect=true]  
         * @returns {Promise}
         */
        async function disconnect(reconnect = true) {
            if (!connected) return;
            connected = false;

            clearInterval(_cycleInterval);
            _cycleInterval = null;

            if (plcs5) {
                if (!reconnect) plcs5.removeListener('disconnected', onDisconnect);
                await plcs5.destroy();
                removeListeners();
                plcs5 = null;
            }
        }
        
        async function connect() {
            
            manageStatus('connecting');
            
            if (plcs5 !== null) {
                await disconnect();
            }
            
            if (!portPath) {
                manageStatus('offline');
                that.error('Undefined port path!');
                return;
            }
            
            plcs5 = new nodes5.S5PLC (portPath,{timeout:currentCycleTime});
            plcs5.on('connected', onConnect);
            plcs5.on('disconnected', onDisconnect);
            plcs5.on('error', onError);
            plcs5.on('timeout', onTimeout);
            plcs5.on('plcconnected', onPlcConnect);
            plcs5.on('plcdisconnected', onPlcDisconnected);
            plcs5.connect();

            addressGroup = new nodes5.s5itemGroup(plcs5);

        }

        function onPlcConnect() {
            manageStatus('online');
        }

        function onPlcDisconnected() {
            manageStatus('offline');
        }

        function onConnect() {
            readInProgress = false;
            readDeferred = 0;
            connected = true;

            if (_reconnectTimeout !== null) {
                clearInterval(_reconnectTimeout);
                _reconnectTimeout = null;
            }

            that.emit('connected')

            manageStatus('online');

            let _vars = createTranslationTable(config.vartable);

            addressGroup.setTranslationCB(k => _vars[k]);
            let varKeys = Object.keys(_vars);

            if (!varKeys || !varKeys.length) {
                that.warn(RED._("s5.plc.info.novars"));
            } else {
                addressGroup.addItems(varKeys);
                updateCycleTime(currentCycleTime);
            }
        }

        function onDisconnect() {

            that.emit('disconnected')
            connected = false;
            manageStatus('offline');
            if (!_reconnectTimeout) {
                _reconnectTimeout = setInterval(connect, 5000);
            }
        }

        function onError(e) {
            manageStatus('offline');
            that.error(e && e.toString());
            disconnect();
        }

        function onTimeout(e) {
            that.emit('timeout')

            manageStatus('offline');
            that.error(e && e.toString());
            disconnect();
        }

        function getStatus() {
            that.emit('__STATUS__', status);
        }

        function updateCycleEvent(obj) {
            obj.err = updateCycleTime(obj.msg.payload);
            that.emit('__UPDATE_CYCLE_RES__', obj);
        }

        manageStatus('offline');

        this.on('__DO_CYCLE__', doCycle);
        this.on('__UPDATE_CYCLE__', updateCycleEvent);
        this.on('__GET_STATUS__', getStatus);

        connect();

        this.on('close', done => {
            manageStatus('offline');
            clearInterval(_cycleInterval);
            clearTimeout(_reconnectTimeout);
            _cycleInterval = null
            _reconnectTimeout = null;
            
            that.removeListener('__DO_CYCLE__', doCycle);
            that.removeListener('__UPDATE_CYCLE__', updateCycleEvent);
            that.removeListener('__GET_STATUS__', getStatus);           

            disconnect(false).then(done);
        });
        
    }

    RED.nodes.registerType('s5 plc', S5Plc);

    // <Begin> --- S5 In
    function S5In(config) {
        RED.nodes.createNode(this, config);
        let statusVal;
        let that = this

        let s5plc = RED.nodes.getNode(config.plc);

        if (!s5plc) {
            that.error(RED._("s5.error.missingconfig"));
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
            that.send(msg);
            s5plc.emit('__GET_STATUS__');
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

        function onS5Status(status) {
            that.status(generateStatus(status, statusVal));
        }
        
        s5plc.on('__STATUS__', onS5Status);
        s5plc.emit('__GET_STATUS__');

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
            s5plc.removeListener('__STATUS__', onS5Status);
            s5plc.removeListener(config.variable, onData);
            done();
        });

    }

    RED.nodes.registerType('s5 in', S5In);
    // <End> --- S5 In

    // <Begin> --- S5 Control
    function S5Control(config) {
        let that = this;
        RED.nodes.createNode(this, config);

        let s5plc = RED.nodes.getNode(config.plc);

        if (!s5plc) {
            this.error(RED._("df1.error.missingconfig"));
            return;
        }

        function onS5Status(status) {
            that.status(generateStatus(status));
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

        s5plc.on('__STATUS__', onS5Status);
        s5plc.on('__UPDATE_CYCLE_RES__', onUpdateCycle);

        s5plc.emit('__GET_STATUS__');

        nrInputShim(this, onMessage);

        this.on('close', function (done) {
            s5plc.removeListener('__STATUS__', onS5Status);
            s5plc.removeListener('__UPDATE_CYCLE_RES__', onUpdateCycle);
            done();
        });

    }
    RED.nodes.registerType("s5 control", S5Control);
    // <End> --- S5 Control
}

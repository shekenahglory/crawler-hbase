var Promise = require('bluebird');
var moment = require('moment');
var _ = require('lodash');
var utils = require('./utils');

var tableList = [
  {
    name: 'crawls',
    columnFamilies: ['c']
  },
  {
    name: 'connections',
    columnFamilies: ['cn']
  },
  {
    name: 'crawl_node_stats',
    columnFamilies: ['s']
  },
  {
    name: 'raw_crawls',
    columnFamilies: ['rc']
  },
  {
    name: 'nodes',
    columnFamilies: ['n']
  },
  {
    name: 'node_state',
    columnFamilies: ['n']
  }
];

function normalizeData(rows) {
  function normOne(r) {
    return _.mapValues(r, function(rProp) {
      return rProp.toString("UTF-8");
    })
  }
  if (rows instanceof Array)  return _.map(rows, normOne);
  else return normOne(rows);
}

function CrawlHbaseClient(dbUrl) {
  this._hbase = require('./database').initHbase(dbUrl);
}

CrawlHbaseClient.prototype.initTables = function(recreate) {
  var self = this;

  if (recreate) {
    return Promise.map(tableList, function(table) {
      return self._hbase.deleteTable(table);
    }).then(createTables);

  } else {
    return createTables();
  }

  function createTables() {
    return Promise.map(tableList, function(table) {
      return self._hbase.createTable(table);
    });
  }
};

CrawlHbaseClient.prototype.storeRawCrawl = function(crawl) {
  var self = this;
  return new Promise(function(resolve, reject) {
    var key = moment(crawl.start).valueOf() + '_' + moment(crawl.end).valueOf();
    var cols = {
      'rc:entry_ipp':  crawl.entry,
      'rc:data':       JSON.stringify(crawl.data),
      'rc:exceptions': JSON.stringify(crawl.errors)
    };
    self._hbase
    .putRow({
      table: 'raw_crawls',
      rowkey: key,
      columns: cols
    })
    .then(function() {
      resolve(key);
    })
    .catch(reject);
  });
};

/**
 * the generic get function used by almost all the other specific gets
 * @param  {string} startKey - scan start
 * @param  {string} endKey  - scan end
 * @param  {number} limit - limit results
 * @param  {bool} descending - order DESC
 * @param  {string} tableName  - table to use
 * @param  {string} filterString - filter for scanner
 * @return {Array}
 */
CrawlHbaseClient.prototype.getRows = function(startKey, endKey, limit, descending, tableName, filterString) {
  tableName = tableName || 'raw_crawls';
  var self = this;
  return new Promise(function(resolve, reject) {
    var options = {
        table: tableName,
        startRow: startKey,
        stopRow: endKey
      };
    if (descending) options.descending = true;
    if (limit) options.limit = limit;
    if (filterString) options.filterString = filterString;
    self._hbase.getScan(options, function(err, resp) {
      if (err) return reject(err);
      return resolve(normalizeData(resp));
    });
  });
};

CrawlHbaseClient.prototype.getRow = function(options) {
  var self = this;
  return new Promise(function(resolve, reject) {
    self._hbase.getRow(options, function(err, resp) {
      if (err) {
        reject(err);
      } else {
        resolve(normalizeData(resp));
      }
    });
  });
};

CrawlHbaseClient.prototype.getLatestRawCrawl = function() {
  var self = this;
  return new Promise(function(resolve, reject) {
    self.getRows('0', '9', 1, true)
    .then(function(rows) {
      resolve(rows[0]);
    })
    .catch(reject);
  });
};

CrawlHbaseClient.prototype.getRawCrawlByKey = function(key) {
  var self = this;
  return new Promise(function(resolve, reject) {
      self.getRows(key, key)
      .then(function(rows) {
        if (rows.length) {
          resolve(rows[0]);
        } else {
          reject('no rows with given key found');
        }
      })
      .catch(reject);
    });
};
/**
 *
 * @param  {Object} newProcessedCrawl - is in the following format
 * {
 *   crawl: <id, start, end, entry>,
 *   rippleds: <array of rippleds>
 *   connections: <Object with keys as links between rippleds>
 * }
 * @param  {Object} oldProcessedCrawl - same format as newProcessedCrawl
 * @return {[type]}                   [description]
 */
CrawlHbaseClient.prototype.storeProcessedCrawl = function(newProcessedCrawl, oldProcessedCrawl) {
  var self = this;
  return new Promise(function(resolve, reject) {
    var crawlKey = newProcessedCrawl.crawl.id;
    var changedNodes = self.buildChangedNodes(newProcessedCrawl.rippleds, oldProcessedCrawl && oldProcessedCrawl.rippleds);
    var nodeStats = self.buildNodeStats(newProcessedCrawl, oldProcessedCrawl);
    Promise.all([
      self.storeChangedNodes(changedNodes, crawlKey),
      self.storeCrawlNodeStats(nodeStats, crawlKey),
      self.storeConnections(newProcessedCrawl.connections, crawlKey),
    ])
    .then(function(retArray) {
      return self.storeCrawlInfo(newProcessedCrawl.crawl, crawlKey);
    })
    .then(function(retArray) {
      resolve(crawlKey);
    })
    .catch(reject);
  });
};

CrawlHbaseClient.prototype.storeCrawlInfo = function(crawl, crawlKey) {
  var self = this;
  var cols = {
    'c:entry': crawl.entry || 'not_present',
  };
  return self._hbase.putRow({
    table: 'crawls',
    rowkey: crawlKey,
    columns: cols
  });
};

/**
 * get processed crawl info by crawlKey, or the latest crawl if the crawlKey is not specified
 * @param  {string} crawlKey
 * @return {Object}
 */
CrawlHbaseClient.prototype.getCrawlInfo = function(crawlKey) {
  var self = this;
  return new Promise(function(resolve, reject) {
    crawlKey = crawlKey || '9';
    self.getRows('0', crawlKey, 1, true, 'crawls')
    .then(function(rows) {
      if (rows.length) {
        resolve(rows[0]);
      } else {
        reject('no crawls with given key found');
      }
    })
    .catch(reject);
  });
};

CrawlHbaseClient.prototype.buildNodeStats = function(newCrawl, oldCrawl) {
  var np = utils.getInAndOutGoingPeers(newCrawl.connections);
  var op = utils.getInAndOutGoingPeers(oldCrawl && oldCrawl.connections);

  var nodeStats = _.mapValues(newCrawl.rippleds, function(n, pubKey) {
    var ret = {};
    ret.exceptions = n.errors;
    ret.uptime = n.uptime;
    ret.request_time = n.request_time;
    ret.in_count = n.in;
    ret.out_count = n.out;
    ret.ipp = n.ipp;
    ret.version = n.version;
    ret.pubkey = pubKey;


    var addedInPeers = _.filter(np.ingoings[pubKey], function(inPeer) {
      return !op.ingoings[pubKey] || op.ingoings[pubKey].indexOf(inPeer) === -1;
    });

    var addedOutPeers = _.filter(np.outgoings[pubKey], function(outPeer) {
      return !op.outgoings[pubKey] || op.outgoings[pubKey].indexOf(outPeer) === -1;
    });

    var droppedInPeers = _.filter(op.ingoings[pubKey], function(inPeer) {
      return !np.ingoings[pubKey] || np.ingoings[pubKey].indexOf(inPeer) === -1;
    });

    var droppedOutPeers = _.filter(op.outgoings[pubKey], function(outPeer) {
      return !np.outgoings[pubKey] || np.outgoings[pubKey].indexOf(outPeer) === -1;
    });
    ret.in_add_count = addedInPeers.length;
    ret.out_add_count = addedOutPeers.length;
    ret.in_drop_count = droppedInPeers.length;
    ret.out_drop_count = droppedOutPeers.length;
    return ret;
  });

  return nodeStats;
};

/**
 * returns the nodes that either just appeared or have changed since last crawl
 * @param  {Object} newCrawl
 * @param  {Object} oldCrawl
 * @return {Object}
 */
CrawlHbaseClient.prototype.buildChangedNodes = function(newNodes, oldNodes) {
  var changedNodes = _.pick(newNodes, function(nn, pubKey) {
    var on = oldNodes && oldNodes[pubKey];
    return (!on || on.ipp !== nn.ipp || on.version !== nn.version);
  });
  return changedNodes;
};

CrawlHbaseClient.prototype.storeChangedNodes = function(nodes, crawlKey) {
  var self = this;
  var changedNodes = {};
  var nodeState = {};
  var cols;

  for (var pubkey in nodes) {
    changedNodes[utils.getNodesKey(crawlKey, pubkey)] = {
      'n:ipp': nodes[pubkey].ipp || 'not_present',
      'n:version': nodes[pubkey].version || 'not_present',
    };
    nodeState[pubkey] = {
      'n:ipp': nodes[pubkey].ipp || 'not_present',
      'n:version': nodes[pubkey].version || 'not_present',
      'n:last_updated': moment().utc().format('YYYY-MM-DDTHH:mm:ss[Z]')
    };
  }

  return self._hbase.putRows({
    table: 'nodes',
    rows: changedNodes
  }).then(function() {
    return self._hbase.putRows({
      table: 'node_state',
      rows: nodeState
    });
  })
};

CrawlHbaseClient.prototype.getNodeHistory = function(pubKey) {
  var self = this;
  var startKey = utils.getNodesKey('0', pubKey);
  var stopKey = utils.getNodesKey('9', pubKey);
  return self.getRows(startKey, stopKey, false, false, 'nodes');
};

CrawlHbaseClient.prototype.getNodeState = function(pubKey) {
  var self = this;
  return self.getRow({
    table: 'node_state',
    rowkey: pubKey
  }).then(function(row) {
    row.node_pubkey = row.rowkey;
    delete row.rowkey;
    return row;
  });
};

CrawlHbaseClient.prototype.storeCrawlNodeStats = function(nodes, crawlKey) {
  var self = this;
  var rows = _.object(_.map(nodes, function(n, pubKey) {
    var key = utils.getCrawlNodeStatsKey(crawlKey, pubKey);
    var cols = {
      's:ipp': n.ipp,
      's:version': n.version,
      's:uptime': n.uptime,
      's:request_time': n.request_time,
      's:exceptions': n.exceptions,
      's:in_count': n.in_count,
      's:out_count': n.out_count,
      's:in_add_count': n.in_add_count,
      's:in_drop_count': n.in_drop_count,
      's:out_add_count': n.out_add_count,
      's:out_drop_count': n.out_drop_count,
      's:pubkey': n.pubkey,
    };
    return [key, cols];
  }));
  return self._hbase.putRows({
    table: 'crawl_node_stats',
    rows: rows
  });
};

CrawlHbaseClient.prototype.getCrawlNodeStats = function(crawlKey) {
  var self = this;
  var startKey = utils.getCrawlNodeStatsKey(crawlKey, '0');
  var stopKey = utils.getCrawlNodeStatsKey(crawlKey, 'z');
  return self.getRows(startKey, stopKey, false, false, 'crawl_node_stats');
};


CrawlHbaseClient.prototype.storeConnections = function(connections, crawlKey) {
  var self = this;
  var rows = _.object(_.map(connections, function(val, from_to) {
    var from = from_to.split(',')[0];
    var to = from_to.split(',')[1];
    var key = utils.getConnectionKey(crawlKey, from, to);
    var cols = {
      'cn:to': to
    };
    return [key, cols];
  }));
  return self._hbase.putRows({
    table: 'connections',
    rows: rows
  });
};

CrawlHbaseClient.prototype.getConnections = function(crawlKey, pubKey, type) {
  var self = this;
  var startKey, stopKey;
  var fs;
  if(type === 'in') {
    //going to use column filter for this case
    fs = self._hbase.buildSingleColumnValueFilters([{family:'cn', qualifier: 'to', comparator: "=", value: pubKey}]);
    startKey = utils.getConnectionKey(crawlKey, '0', '0');
    stopKey = utils.getConnectionKey(crawlKey, 'z', 'z');
  } else {
    startKey = utils.getConnectionKey(crawlKey, pubKey, '0');
    stopKey = utils.getConnectionKey(crawlKey, pubKey, 'z');
  }
  return self.getRows(startKey, stopKey, false, false, 'connections', fs);
};

CrawlHbaseClient.prototype.getAllConnections = function(crawlKey) {
  var self = this;
  var startKey = utils.getConnectionKey(crawlKey, '0', '0');
  var stopKey = utils.getConnectionKey(crawlKey, 'z', 'z');
  return self.getRows(startKey, stopKey, false, false, 'connections');
};

module.exports = CrawlHbaseClient;

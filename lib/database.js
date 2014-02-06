/**
 * Module dependencies
 */

var _ = require('lodash'),
    fs = require('fs-extra'),
    async = require('async'),
    waterlineCriteria = require('waterline-criteria'),
    Aggregate = require('./aggregates'),
    Errors = require('waterline-errors').adapter;

/**
 * A File-Backed Datastore
 *
 * @param {Object} config
 * @param {Object} collections
 * @return {Object}
 * @api public
 */

var Database = module.exports = function(config, collections) {
  var self = this;

  // Hold Config values for each collection, this allows each collection
  // to define which file the data is synced to
  this.config = config || {};

  // Build a filePath
  this.filePath = this.config.filePath + this.config.identity + '.db';

  // Hold Collections
  this.collections = collections || {};

  // Build an object to hold the data
  this.data = {};

  // Build a Counters Object for Auto-Increment
  this.counters = {};

  // Hold Schema Objects to describe the structure of an object
  this.schema = {};

  // Create a Write Queue to ensure only 1 write to a file is happening at once
  this.writeQueue = async.queue(function(collectionName, cb) {
    self.write(collectionName, cb);
  }, 1);

  return this;
};

/**
 * Initialize Database
 *
 */

Database.prototype.initialize = function(cb) {
  var self = this;

  async.auto({

    checkData: function(next) {
      if(Object.keys(self.data).length > 0) return next();
      self.read(next);
    },

    setCollection: ['checkData', function(next) {
      async.eachSeries(Object.keys(self.collections), function(key, nextCollection) {
        var collection = self.collections[key];
        self.registerCollection(key, collection, nextCollection);
      }, next);
    }]

  }, cb);

};

/**
 * Register Collection
 *
 * @param {String} collectionName
 * @param {Object} collection
 * @param {Function} callback
 * @api public
 */

Database.prototype.registerCollection = function(collectionName, collection, cb) {
  this.setCollection(collectionName, collection, cb);
};

/**
 * Set Collection
 *
 * @param {String} collectionName
 * @param {Object} definition
 * @return Object
 * @api private
 */

Database.prototype.setCollection = function(collectionName, options, cb) {

  // If no filePath is set for this collection, return an error in the object
  if(!this.filePath) return cb(new Error('No filePath was configured for this collection'));

  // Set Defaults
  var data = this.data[collectionName] || [];
  data.concat(options.data || []);

  // Ensure data is set
  this.data[collectionName] = data || [];

  // Set counters
  var counters = this.counters[collectionName] = this.counters[collectionName] || {};

  if(options.definition) options.definition = _.cloneDeep(options.definition);
  var schema = this.schema[collectionName] = options.definition || {};

  var obj = {
    data: data,
    schema: schema,
    counters: counters
  };

  cb(null, obj);
};

/**
 * Get Collection
 *
 * @param {String} collectionName
 * @return {Object}
 * @api private
 */

Database.prototype.getCollection = function(collectionName, cb) {

  // If no filePath is set for this collection, return an error in the object
  if(!this.filePath) return cb(new Error('No filePath was configured for this collection'));

  var obj = {
    data: this.data[collectionName] || {},
    schema: this.schema[collectionName] || {},
    counters: this.counters[collectionName] || {}
  };

  cb(null, obj);
};

/**
 * Write Data To Disk
 *
 * @param {String} collectionName
 * @param {Function} callback
 * @api private
 */

Database.prototype.write = function(collectionName, cb) {
  var self = this;

  if(!this.filePath) return cb(new Error('No filePath was configured for this collection'));

  var data = this.data;
  var schema = this.schema;
  var counters = this.counters;

  fs.createFile(this.filePath, function(err) {
    if(err) return cb(err);
    fs.outputJson(self.filePath, { data: data, schema: schema, counters: counters }, cb);
  });
};

/**
 * Read Data From Disk
 *
 * @param {Function} callback
 * @api private
 */

Database.prototype.read = function(cb) {
  var self = this;

  if(!this.filePath) return cb(new Error('No filePath was configured for this collection'));

  fs.exists(this.filePath, function(exists) {
    self.data = {};

    if(!exists) {
      return fs.createFile(self.filePath, function(err) {
        if(err) return cb(err);
        cb(null, { data: {}, schema: {}, counters: {} });
      });
    }

    // Check if we have already read the data file into memory
    if(Object.keys(self.data).length !== 0) return cb(null, {
      data: self.data,
      schema: self.schema,
      counters: self.schema
    });

    fs.readFile(self.filePath, { encoding: 'utf8' }, function (err, data) {
      if(err) return cb(err);
      if(!data) return cb(null, { data: {}, schema: {}, counters: {} });

      var state;

      try {
        state = JSON.parse(data);
      }
      catch (e) {
        return cb(e);
      }

      self.data = state.data;
      self.schema = state.schema;
      self.counters = state.counters;

      cb(null, { data: state.data, schema: state.schema, counters: state.counters });
    });
  });
};

///////////////////////////////////////////////////////////////////////////////////////////
/// DDL
///////////////////////////////////////////////////////////////////////////////////////////

/**
 * Register a new Collection
 *
 * @param {String} collectionName
 * @param {Object} definition
 * @param {Function} callback
 * @return Object
 * @api public
 */

Database.prototype.createCollection = function(collectionName, definition, cb) {
  var self = this;

  this.setCollection(collectionName, { definition: definition }, function(err, collection) {
    if(err) return cb(err);

    self.writeQueue.push(collectionName);
    cb(null, collection.schema);
  });
};

/**
 * Describe a collection
 *
 * @param {String} collectionName
 * @param {Function} callback
 * @api public
 */

Database.prototype.describe = function(collectionName, cb) {

  this.getCollection(collectionName, function(err, data) {
    if(err) return cb(err);

    var schema = Object.keys(data.schema).length > 0 ? data.schema : null;
    cb(null, schema);
  });
};

/**
 * Drop a Collection
 *
 * @param {String} collectionName
 * @api public
 */

Database.prototype.dropCollection = function(collectionName, relations, cb) {
  var self = this;

  if(typeof relations === 'function') {
    cb = relations;
    relations = [];
  }

  // If no filePath is set for this collection, return an error in the object
  if(!this.filePath) return {
    error: new Error('No filePath was configured for this collection')
  };

  delete this.data[collectionName];
  delete this.schema[collectionName];

  relations.forEach(function(relation) {
    delete self.data[relation];
    delete self.schema[relation];
  });

  this.write(collectionName, cb);
};

///////////////////////////////////////////////////////////////////////////////////////////
/// DQL
///////////////////////////////////////////////////////////////////////////////////////////

/**
 * Select
 *
 * @param {String} collectionName
 * @param {Object} options
 * @param {Function} cb
 * @api public
 */

Database.prototype.select = function(collectionName, options, cb) {

  // If no filePath is set for this collection, return an error in the object
  if(!this.filePath) return cb(new Error('No filePath was configured for this collection'));

  // Filter Data based on Options criteria
  var resultSet = waterlineCriteria(collectionName, this.data, options);

  // Process Aggregate Options
  var aggregate = new Aggregate(options, resultSet.results);

  if(aggregate.error) return cb(aggregate.error);
  cb(null, aggregate.results);
};

/**
 * Insert A Record
 *
 * @param {String} collectionName
 * @param {Object} values
 * @param {Function} callback
 * @return {Object}
 * @api public
 */

Database.prototype.insert = function(collectionName, values, cb) {

  // If no filePath is set for this collection, return an error in the object
  if(!this.filePath) return cb(new Error('No filePath was configured for this collection'));

  // Check Uniqueness Constraints
  var errors = this.uniqueConstraint(collectionName, values);
  if(errors && errors.length > 0) return cb(errors);

  // Auto-Increment any values
  values = this.autoIncrement(collectionName, values);
  values = this.serializeValues(collectionName, values);

  if (!this.data[collectionName]) return cb(Errors.CollectionNotRegistered);
  this.data[collectionName].push(values);

  this.writeQueue.push(collectionName);
  cb(null, values);
};

/**
 * Update A Record
 *
 * @param {String} collectionName
 * @param {Object} options
 * @param {Object} values
 * @param {Function} callback
 * @api public
 */

Database.prototype.update = function(collectionName, options, values, cb) {
  var self = this;

  // If no filePath is set for this collection, return an error in the object
  if(!this.filePath) return cb(new Error('No filePath was configured for this collection'));

  // Filter Data based on Options criteria
  var resultSet = waterlineCriteria(collectionName, this.data, options);

  // Get a list of any attributes we're updating that:
  // i) are in the schema
  // ii) have uniqueness constraints
  var uniqueAttrs = _.where(_.keys(values), function(attrName) {
    var attributeDef = self.schema[collectionName][attrName];
    return attributeDef && attributeDef.unique;
  });

  // If we're updating any attributes that are supposed to be unique, do some additional checks
  if (uniqueAttrs.length && resultSet.indicies.length) {

    // If we would be updating more than one record, then uniqueness constraint automatically fails
    if (resultSet.indicies.length > 1) {
      var error = new Error('Uniqueness check failed on attributes: ' + uniqueAttrs.join(','));
      return cb(error);
    }

    // Otherwise for each unique attribute, ensure that the matching result already has the value
    // we're updating it to, so that there wouldn't be more than one record with the same value.
    else {
      var result = self.data[collectionName][resultSet.indicies[0]];
      var errors = [];
      _.each(uniqueAttrs, function(uniqueAttr) {
        if (result[uniqueAttr] != values[uniqueAttr]) {
          errors.push(new Error('Uniqueness check failed on attribute: ' + uniqueAttr + ' with value: ' + values[uniqueAttr]));
        }
      });
      if (errors.length) {
        return cb(errors);
      }
    }
  }

  var results = [];

  resultSet.indicies.forEach(function(matchIndex) {
    var _values = self.data[collectionName][matchIndex];
    self.data[collectionName][matchIndex] = _.extend(_values, values);
    results.push(_.cloneDeep(self.data[collectionName][matchIndex]));
  });

  this.writeQueue.push(collectionName);
  cb(null, results);
};

/**
 * Destroy A Record
 *
 * @param {String} collectionName
 * @param {Object} options
 * @param {Function} callback
 * @api public
 */

Database.prototype.destroy = function(collectionName, options, cb) {
  var self = this;

  // If no filePath is set for this collection, return an error in the object
  if(!this.filePath) return cb(new Error('No filePath was configured for this collection'));

  // Filter Data based on Options criteria
  var resultSet = waterlineCriteria(collectionName, this.data, options);

  this.data[collectionName] = _.reject(this.data[collectionName], function (model, i) {
    return _.contains(resultSet.indicies, i);
  });

  this.writeQueue.push(collectionName);
  cb();
};

///////////////////////////////////////////////////////////////////////////////////////////
/// CONSTRAINTS
///////////////////////////////////////////////////////////////////////////////////////////

/**
 * Auto-Increment values based on schema definition
 *
 * @param {String} collectionName
 * @param {Object} values
 * @return {Object}
 * @api private
 */

Database.prototype.autoIncrement = function(collectionName, values) {

  for (var attrName in this.schema[collectionName]) {
    var attrDef = this.schema[collectionName][attrName];

    // Only apply autoIncrement if value is not specified
    if(!attrDef.autoIncrement) continue;
    if(values[attrName]) continue;

    // Set Initial Counter Value to 0 for this attribute if not set
    if(!this.counters[collectionName][attrName]) this.counters[collectionName][attrName] = 0;

    // Increment AI counter
    this.counters[collectionName][attrName]++;

    // Set data to current auto-increment value
    values[attrName] = this.counters[collectionName][attrName];
  }

  return values;
};

/**
 * Serialize Values
 *
 * Serializes/Casts values before inserting.
 *
 * @param {Object} values
 * @return {Object}
 * @api private
 */

Database.prototype.serializeValues = function(collectionName, values) {
  var self = this;

  Object.keys(values).forEach(function(key) {

    // Check if a type exist in the schema
    if(!self.schema[collectionName]) return;
    if(!self.schema[collectionName].hasOwnProperty(key)) return;

    var type = self.schema[collectionName][key].type,
        val;

    if(type === 'json') {
      try {
        val = JSON.parse(values[key]);
      } catch(e) {
        return;
      }
      values[key] = val;
    }
  });

  return values;
};

/**
 * Unique Constraint
 *
 * @param {String} collectionName
 * @param {Object} values
 * @return {Array}
 * @api private
 */

Database.prototype.uniqueConstraint = function(collectionName, values) {

  var errors = [];

  for (var attrName in this.schema[collectionName]) {
    var attrDef = this.schema[collectionName][attrName];

    if(!attrDef.unique) continue;

    for (var index in this.data[collectionName]) {

      // Ignore uniquness check on undefined values
      if (_.isUndefined(values[attrName])) continue;

      if (values[attrName] === this.data[collectionName][index][attrName]) {
        var error = new Error('Uniqueness check failed on attribute: ' + attrName +
          ' with value: ' + values[attrName]);

        errors.push(error);
      }
    }
  }

  return errors;
};
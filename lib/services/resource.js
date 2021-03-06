(function() {

  var module = angular.module('cores.services');

  //
  // Create an error object from a response
  //
  function makeError(response) {

    var msg = response.msg || '';
    if (!msg && response.data) {
      msg = response.data.message || response.data.error;
    }

    var err = new Error(msg);
    err.code = response.code || response.status;

    if (response.config) {
      err.config = response.config;
    }

    if (response.data && response.data.errors) {
      err.errors = response.data.errors;
    }
    return err;
  };


  //
  // crResource
  //
  module.factory('crResource', function($http, $q, $rootScope) {

    var Resource = function(type, config, apiUrl) {

      this.type = type;

      // add config to this
      angular.extend(
        this,
        { path: '', schemaPath: '', viewPaths: {}, searchPaths: {} },
        config
      );

      if (apiUrl) {
        // extend all paths with api url
        this.path = apiUrl + this.path;
        this.schemaPath = apiUrl + this.schemaPath;

        var self = this;
        angular.forEach(this.viewPaths, function(path, name) {
          self.viewPaths[name] = apiUrl + path;
        });
        angular.forEach(this.searchPaths, function(path, name) {
          self.searchPaths[name] = apiUrl + path;
        });
      }
    };


    //
    // Get a resource schema
    //
    Resource.prototype.schema = function() {

      return $http.get(this.schemaPath).then(
        function(res) { return res.data; },
        function(res) { return $q.reject(makeError(res)); }
      );
    };


    //
    // Load a resource from the server
    //
    Resource.prototype.load = function(id, params) {

      var path = this.path;

      if (id) {
        if (typeof id === 'string') {
          path += '/' + id;
        }
        else if (typeof id === 'object' && !params) {
          // params passed as first arg
          params = id;
        }
      }
      var config = { params: params };

      return $http.get(path, config).then(
        function(res) { return res.data; },
        function(res) { return $q.reject(makeError(res)); }
      );
    };


    //
    // Save/update a resource on the server
    //
    Resource.prototype.save = function(doc, files) {

      doc = JSON.parse(JSON.stringify(doc));

      if (files && !angular.isArray(files)) {
        files = [files];
      }
      var isMultipart = false;
      var docId = doc._id;
      var docRev = doc._rev;

      // create multipart formdata when saving files

      if (files && files.length) {
        var fd = new FormData();
        fd.append('type_', this.type);
        fd.append('doc', JSON.stringify(doc));

        files.forEach(function(file, i) {
          fd.append('file' + i, file);
        });
        fd.append('numFiles', files.length);

        // when updating, add the id and rev
        if (docId)  fd.append('_id', docId);
        if (docRev) fd.append('_rev', docRev);

        doc = fd;
        isMultipart = true;
      }

      var req  = {
        url: this.path,
        method: 'POST',
        data: doc
      };
      if (docId && docRev) {
        // update
        req.method = 'PUT';
        req.url += '/' + docId + '/' + docRev;
      }
      else if (docId) {
        // create with id
        req.method = 'PUT';
        req.url += '/' + docId;
      }

      if (isMultipart) {
        return this._sendMultipart(req);
      }
      else {
        return $http(req).then(
          function(res) { return res.data; },
          function(res) { return $q.reject(makeError(res)); }
        );
      }
    };


    Resource.prototype._sendMultipart = function(req) {
      var def = $q.defer();

      // send multipart manually with xhr for now, $http seems to have problems with it
      var xhr = new XMLHttpRequest();

      xhr.addEventListener('load', function() {

        var data = typeof xhr.response === 'string' ? JSON.parse(xhr.response) : xhr.response;

        if (xhr.status === 200) {
          def.resolve(data);
        }
        else {
          def.reject(makeError({code: xhr.status, data: data}));
        }
        // call apply, because we are outside the angular life-cycle
        $rootScope.$apply();
      });

      xhr.open(req.method, req.url);

      // inherit default http headers from angulars http service
      var headers = $http.defaults.headers.common;
      angular.forEach(headers, function(value, key) {
        xhr.setRequestHeader(key, value);
      });

      xhr.send(req.data);

      return def.promise;
    };


    //
    // Delete a resource on the server
    //
    Resource.prototype.destroy = function(doc) {

      if (!doc._id || !doc._rev) {
        throw new Error('Cannot delete doc without id or rev');
      }
      return $http.delete(this.path + '/' + doc._id + '/' + doc._rev).then(
        function(res) {},
        function(res) { return $q.reject(makeError(res)); }
      );
    };


    function parseViewQuery(qs) {
      // stringify non string params as json, to preserve them
      // angularjs http will otherwise do funky stuff with array params
      var r = {};
      for (var x in qs) {
        if (typeof qs[x] !== 'string') {
          r[x] = JSON.stringify(qs[x]);
        }
        else {
          r[x] = '\"' + qs[x] + '\"';
        }
      }
      return r;
    }


    //
    // Call a couchdb view
    //
    Resource.prototype.view = function(name, params) {

      var path = this.viewPaths[name];
      if (!path) {
        throw new Error('No view with name found: ' + name);
      }
      return $http.get(path, { params: parseViewQuery(params) }).then(
        function(res) { return res.data; },
        function(res) { return $q.reject(makeError(res)); }
      );
    };

    //
    // Call a couchdb search index
    //
    Resource.prototype.search = function(name, params) {

      var path = this.searchPaths[name];
      if (!path) {
        throw new Error('No search index with name found: ' + name);
      }
      return $http.get(path, { params: params }).then(
        function(res) { return res.data; },
        function(res) { return $q.reject(makeError(res)); }
      );
    };

    return Resource;
  });


  //
  // crResources
  //
  module.service('crResources', function($http, $q, $rootScope, crResource) {


    var Resources = function() {

      this._resources = {};
      this._apiUrl = '';
    };


    Resources.prototype.init = function(options) {

      options = options || {};
      this._apiUrl = options.url || '';

      var self = this;

      return $http.get(this._apiUrl + '/_index').then(

        function(res) {
          console.log('index', res.data);
          angular.forEach(res.data, function(config, key) {
            self._resources[key] = new crResource(key, config, self._apiUrl);
          });
          return self._resources;
        },
        function(res) {
          return $q.reject(makeError(res));
        }
      );
    };


    Resources.prototype.getIds = function(count) {

      count = count || 1;

      return $http.get(this._apiUrl + '/_uuids?count=' + count).then(
        function(res) {
          return res.data.uuids;
        },
        function(res) {
          return $q.reject(makeError(res));
        }
      );
    };


    Resources.prototype.get = function(type) {

      var r = this._resources[type];
      if (!r) {
        throw new Error('Resource with type not found: ' + type);
      }
      return r;
    };


    return new Resources();
  });

})();

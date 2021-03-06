import RestClient from './rest-client';
import helper from '../common/helper';

const getConsumerOptions = (opt, config) => ({
  endpointName: opt.endpointName || config.endpointName,
  apiPathName: opt.apiPathName || config.apiPathName,
});

class RestBaseModel {
  constructor(...[_model, ...args]) {
    const model = _model || {};
    const { constructor } = this;
    const config = this.getConfig();
    const { fields } = config;

    if (helper.isObject(fields)) {
      const fieldKeys = Object.keys(fields);
      const serializers = {};
      for (let i = 0; i < fieldKeys.length; i += 1) {
        const fieldKey = fieldKeys[i];
        if (helper.isFunction(fields[fieldKey].serializer)) {
          serializers[fieldKey] = fields[fieldKey].serializer;
        } else {
          const ModelClass = fields[fieldKey].modelClass;
          const fieldValue =
            model[fields[fieldKey].map] === undefined
              ? model[fieldKey]
              : model[fields[fieldKey].map];
          if (ModelClass && ModelClass.prototype instanceof RestBaseModel) {
            this[fieldKey] = new ModelClass(fieldValue, ...args);
          } else {
            this[fieldKey] = fieldValue;
          }
          if (this[fieldKey] === undefined && fields[fieldKey]) {
            if (helper.isArray(fields[fieldKey].default)) {
              this[fieldKey] = [];
            } else if (helper.isObject(fields[fieldKey].default)) {
              this[fieldKey] = {};
            } else if (fields[fieldKey].default !== undefined) {
              this[fieldKey] = fields[fieldKey].default;
            }
          }
        }
      }
      Object.entries(serializers).forEach(([fieldKey, serializer]) => {
        this[fieldKey] = serializer(...args);
      });
    }

    // define REST consumer
    if (!constructor.consumer) {
      Object.defineProperty(constructor, 'consumer', {
        value: new RestClient(getConsumerOptions({}, config)),
        writable: true,
      });
    }
  }

  getConfig() {
    return {
      fields: {},
    };
  }

  getIdField() {
    const { prototype } = this.constructor;
    const config = prototype.getConfig();
    if (!prototype.hasOwnProperty('_idField')) {
      const { fields } = config;
      Object.defineProperty(prototype, '_idField', {
        value: Object.keys(fields).find(fieldKey => {
          return fields[fieldKey].primary;
        }),
        enumerable: false,
        configurable: false,
        writable: false,
      });
    }
    return prototype._idField;
  }

  save(options) {
    return this.constructor.save({ ...options, model: this });
  }

  static save(options) {
    const opt = options || {};
    if (!(opt.model instanceof this)) {
      throw Error('model must be instance of RestBaseModel');
    }

    const { prototype } = this;
    const _idField = prototype.getIdField();
    const config = prototype.getConfig();
    const id = opt.model[_idField];
    const { fields } = config;
    const consumer = new RestClient(getConsumerOptions(opt, config));
    const path = opt.path || 'default';

    return new Promise((resolve, reject) => {
      let request;
      const isPost = !id;
      const isPatch = Array.isArray(opt.patch);
      const isPut = !isPost && !isPatch;
      const requestType = isPost ? 'post' : isPatch ? 'patch' : 'put';
      const requestData = {};
      const fieldKeys = opt.patch || Object.keys(opt.model);
      for (let i = 0; i < fieldKeys.length; i += 1) {
        const key = fieldKeys[i];
        requestData[(fields[key] || {}).map || key] = opt.model[key];
      }
      (isPost || isPut) && delete requestData[_idField];

      request = consumer[requestType](
        helper.replaceUrlParamsWithValues(
          opt.disableAutoAppendedId
            ? config.paths[path]
            : helper.pathJoin(config.paths[path], encodeURIComponent(id || '')),
          opt.pathData
        ),
        opt.data || requestData,
        config.headers || {}
      );
      if (opt.generateOnly) {
        resolve({ requestURL: request.url });
      } else {
        request
          .exec(opt)
          .then(response => {
            if (isPost) {
              opt.model[_idField] =
                response[(fields[_idField] || {}).map || _idField];
            }
            resolve({ response, request: request.xhr });
          })
          .catch(response => {
            reject({ response, request: request.xhr });
          });
      }
    });
  }

  static get(options) {
    const opt = options || {};
    const config = this.prototype.getConfig();
    const consumer = new RestClient(getConsumerOptions(opt, config));
    const path = opt.path || 'default';
    opt.pathData = opt.pathData || {};
    opt.resultField = opt.resultField || config.resultField;

    return new Promise((resolve, reject) => {
      let resultPath = config.paths[path];
      const { id } = opt;
      if (id && !opt.disableAutoAppendedId) {
        // if there is no pathData.id it should be set
        opt.pathData.id = opt.pathData.id || id;
        if (path === 'default') {
          resultPath = helper.pathJoin(config.paths[path], '{id}');
        }
      }
      // replace url parameters and append query parameters
      resultPath = helper.appendQueryParamsToUrl(
        helper.replaceUrlParamsWithValues(resultPath, opt.pathData),
        opt.queryParams
      );
      const request = consumer.get(resultPath, config.headers || {});
      if (opt.generateOnly) {
        resolve({ requestURL: request.url });
      } else {
        request
          .exec(opt)
          .then(response => {
            let model;
            if (helper.isObject(response)) {
              if (helper.isFunction(opt.resultField)) {
                model = opt.resultField(response);
              } else {
                model = new this(
                  opt.resultField && response[opt.resultField]
                    ? response[opt.resultField]
                    : response,
                  ...(opt.constructorArgs || [])
                );
              }
            }
            resolve({ model, response, request: request.xhr });
          })
          .catch(response => {
            reject({ response, request: request.xhr });
          });
      }
    });
  }

  static all(options) {
    const config = this.prototype.getConfig();
    const opt = options || {};
    const consumer = new RestClient(getConsumerOptions(opt, config));
    const path = opt.path || 'default';
    opt.pathData = opt.pathData || {};
    opt.resultListField = opt.resultListField || config.resultListField;

    return new Promise((resolve, reject) => {
      let resultPath = helper.replaceUrlParamsWithValues(
        config.paths[path],
        opt.pathData
      );
      // replace url parameters and append query parameters
      resultPath = helper.appendQueryParamsToUrl(
        helper.replaceUrlParamsWithValues(resultPath, opt.pathData),
        opt.queryParams
      );
      const request = consumer.get(resultPath, config.headers || {});
      if (opt.generateOnly) {
        resolve({ requestURL: request.url });
      } else {
        request
          .exec(opt)
          .then(response => {
            if (!helper.isArray(opt.resultList)) {
              opt.resultList = [];
            }
            let list;
            if (helper.isFunction(opt.resultListField)) {
              list = opt.resultListField(response);
            } else {
              list =
                opt.resultListField &&
                helper.isArray(response[opt.resultListField])
                  ? response[opt.resultListField]
                  : response;
            }
            opt.resultList.length = 0;
            if (helper.isArray(list)) {
              for (let i = 0; i < list.length; i += 1) {
                const item = list[i];
                const ClassName =
                  opt.resultListItemType &&
                  opt.resultListItemType.prototype instanceof RestBaseModel
                    ? opt.resultListItemType
                    : this;
                helper.isObject(item) &&
                  opt.resultList.push(
                    new ClassName(item, ...(opt.constructorArgs || []))
                  );
              }
            }
            resolve({
              resultList: opt.resultList,
              response,
              request: request.xhr,
            });
          })
          .catch(response => {
            reject({ response, request: request.xhr });
          });
      }
    });
  }

  delete(options) {
    const opt = options || {};
    const { prototype } = this.constructor;
    const _idField = prototype.getIdField();
    const id = opt.id || this[_idField];
    return this.constructor.delete({ ...opt, id });
  }

  static delete(options) {
    const opt = options || {};
    const { prototype } = this;
    const config = prototype.getConfig();
    const { id } = opt;

    const consumer = new RestClient(getConsumerOptions(opt, config));
    const path = opt.path || 'default';

    return new Promise((resolve, reject) => {
      try {
        const request = consumer.delete(
          helper.replaceUrlParamsWithValues(
            opt.disableAutoAppendedId
              ? config.paths[path]
              : helper.pathJoin(
                  config.paths[path],
                  encodeURIComponent(id || '')
                ),
            opt.pathData
          ),
          opt.data,
          config.headers || {}
        );
        if (opt.generateOnly) {
          resolve({ requestURL: request.url });
        } else {
          request
            .exec(opt)
            .then(response => {
              resolve({ response, request: request.xhr });
            })
            .catch(response => {
              reject({ response, request: request.xhr });
            });
        }
      } catch (error) {
        reject(error);
      }
    });
  }
}

export default RestBaseModel;

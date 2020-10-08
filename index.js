export const INFINITE = -1;

/**
 * Class representing a cancellable promise.
 * @extends Promise
 */
export class CancellablePromise extends Promise {
  static get [Symbol.species]() {
    return Promise;
  }

  /**
   * Create an instance of CancellablePromise promise.
   * @param {Function} executor - accepts an object with callbacks 
   *  and a token: { resolve, reject, cancel, token }
   * @param {CancellationToken} token - a cancellation token.
   */
  constructor(executor, token) {
    const withCancellation = async () => {
      const linkedSource = new CancellationTokenSource(token);

      try {
        const linkedToken = linkedSource.token;
        linkedToken.throwIfCancellationRequested();

        const deferred = new Deferred();
        linkedToken.register(deferred.cancel);

        executor({ 
          resolve: deferred.resolve,
          reject: deferred.reject,
          cancel: linkedSource.cancel,
          token: linkedToken,
        });
 
        return await deferred.promise;
      }
      finally {
        // this will free the linkedToken registration
        linkedSource.close();
      }
    };

    super((resolve, reject) => withCancellation().then(resolve, reject));
  }
}

/**
 * Class representing a Delay.
 * @extends Promise
 */
export class Delay extends Promise {
  static get [Symbol.species]() {
    return Promise;
  }

  /**
   * Create an instance of Delay promise.
   * @param {Function} executor - accepts { resolve, reject, cancel, token }
   * @param {CancellationToken} token - Cancellation token.
   */
  constructor(timeout, token) {
    if (!CancellationToken.canBeCanceled(token)) {
      super(resolve => timeout !== INFINITE? 
        setTimeout(resolve, timeout): 
        undefined);
      return;
    }

    const delay = async () => {
      const deferred = new Deferred();
      const id = timeout !== INFINITE?
        setTimeout(deferred.resolve, timeout): 0;

      const rego = token.register(deferred.cancel);
      try {
        await deferred.promise;
      }
      finally {
        if (id) clearTimeout(id);
        rego.unregister();
      }
    };

    super((resolve, reject) => delay().then(resolve, reject));
  }
}

/**
 * Class representing a Deferred.
 */
export class Deferred {
  #promise = null;
  #isCompleted = false;
  #isFaulted = false;
  #isCanceled = false;

  #resove = null;
  #reject = null;
  #cancel = null;

  constructor() {
    this.#promise = new Promise((resolve, reject) => {
      this.#resove = value => {
        if (!this.#isCompleted) {
          this.#isCompleted = true;
          resolve(value);
        }
      };

      this.#reject = error => {
        if (!this.#isCompleted) {
          this.#isCompleted = true;
          this.#isFaulted = true;
          reject(error);
        }
      }

      this.#cancel = () => {
        if (!this.#isCompleted) {
          this.#isCompleted = true;
          this.#isCanceled = true;
          reject(new CancelledError());
        }
      }
    });
  }

  get isCompleted() {
    return this.#isCompleted;    
  }

  get isFaulted() {
    return this.#isFaulted;    
  }

  get isCanceled() {
    return this.#isCanceled;    
  }

  get promise() {
    return this.#promise;    
  }  

  get resolve() {
    return this.#resove;
  }

  get reject() {
    return this.#reject;
  }

  get cancel() {
    return this.#cancel;
  }
}

/**
 * Class representing a CancelledError.
 */
export class CancelledError extends Error {
  constructor(message) {
    super(message ?? "Operation has been cancelled");
  }

  static throwUnlessCancelled(error, log) {
    if (error instanceof CancelledError) {
      return log? log(error): error;
    }
    if (error instanceof AggregateError) {
      // see if all are instances of CancelledError
      const errors = [...error.errors];
      if (errors.some(e => !(e instanceof CancelledError))) {
        throw error;
      }
      errors.forEach(e => log?.(e));
      return error;
    }
    else {
      throw error;
    }
  }
}

/**
 * Class representing a CancellationTokenSource.
 */
export class CancellationTokenSource {
  #isCanceled = false;
  #token = null;
  #regos = new Map();
  #linkedRegos = null;

  #cancel = null;
  #close = null;

  constructor(...linkedTokens) {
    this.#cancel = () => {
      if (this.#isCanceled) {
        return;
      }
      this.#isCanceled = true;
      for (let onCanceled of this.#regos.values()) {
        onCanceled();
      }
    }

    this.#close = () => {
      if (this.#linkedRegos) {
        this.#linkedRegos.forEach(rego => rego.unregister());
        this.#linkedRegos.length = 0;
        this.#linkedRegos = null;
      }
      this.#regos?.clear();
    }    

    if (linkedTokens.length != 0) {
      this.#linkedRegos = [];
      for (let token of linkedTokens) {
        if (CancellationToken.canBeCanceled(token)) {
          const rego = token.register(this.#cancel);
          this.#linkedRegos.push(rego);
        }
      }
      if (this.#linkedRegos.length === 0) {
        this.#linkedRegos = null;
      }
    }

    this.#token = new CancellationToken({    
      canceled: () => this.isCancellationRequested,
      register: onCanceled => {
        const rego = { unregister: () => this.#regos.delete(rego) };
        this.#regos.set(rego, onCanceled);
        return rego;
      }
    });
  }

  get isCancellationRequested() { 
    return this.#isCanceled; 
  } 

  get token() { 
    return this.#token; 
  } 

  get cancel() {
    return this.#cancel;
  }

  get close() {
    return this.#close;
  }
}

/**
 * Class representing a CancellationToken.
 */
export class CancellationToken {
  static #none = null;
  
  static #defaultRego = { 
    unregister: () => undefined 
  };
  
  static #defaultSource = { 
    canceled: () => true,
    register: onCanceled => CancellationToken.#defaultRego
  };

  #source = null;
 
  constructor(source) {
    this.#source = source ?? CancellationToken.#defaultSource;
  }

  static canBeCanceled(token) {
    if (token === null || token === undefined) {
      return false;
    }
    if (token instanceof CancellationToken) {
      return token !== CancellationToken.#none; 
    }
    throw new Error('Invalid cancellation token');
  }

  static get none() {
    return CancellationToken.#none ?? (CancellationToken.#none = new CancellationToken())
  }

  get isCancellationRequested() {
    return this.#source.canceled();
  }

  throwIfCancellationRequested() {
    if (this.isCancellationRequested) {
      throw new CancelledError();
    }
  }

  register(onCanceled) {
    if (this.isCancellationRequested) {
      onCanceled();
      return CancellationToken.#defaultRego;
    }
    return this.#source.register(onCanceled);
  }
}

/**
 * Class representing an AsyncLock
 */
export class AsyncLock {
  #deferred = null;

  async wait() {
    verifyThis(this, AsyncLock);    
    while(true) {
      const deferred = this.#deferred;
      if (!deferred) {
        break;
      }
      await deferred.promise;
    }
    this.#deferred = new Deferred();
  }

  release() {
    verifyThis(this, AsyncLock);    
    const deferred = this.#deferred;
    if (deferred) {
      this.#deferred = null;
      deferred.resolve();
    }
    else {
      throw new Error(this.waitAsync.name);
    }
  }
}

/**
 * Class representing an AggregateError
 */
class AggregateError extends Error {
  #errors = [];

	constructor(errors, message) {
		super(message ?? "One ore more errors occured");

    for (const error of errors) {
      if (!(error instanceof Error)) {
        throw new TypeError(`Must be an instance of Error`);
      }
      this.#errors.push(error);
    }
	}

  get errors() {
    return this[Symbol.iterator]();
  }

	* [Symbol.iterator]() {
		for (const error of this.#errors) {
			yield error;
		}
	}
}

/**
 * Class representing an AsyncQueue
 */
export class AsyncQueue {
  #buffer = [];
  #deferred = null;

  get count() {
    return this.#buffer.length; 
  }

  clear() {
    verifyThis(this, AsyncQueue);    
    this.#buffer.length = 0;
  }

  write(...items) {
    verifyThis(this, AsyncQueue);    
    this.#buffer.push(...items)
    const deferred = this.#deferred;
    if (deferred) {
      this.#deferred = null;
      deferred.resolve();
    }
  }

  async read() {
    verifyThis(this, AsyncQueue);    
    while (this.#buffer.length === 0) {
      if (this.#deferred) {
        await this.#deferred;
      }
      else {
        this.#deferred = new Deferred();
      }
    }
    this.#deferred = null;
    return this.#buffer.shift();
  }
}

/**
 * Class representing a CoroutineProxy
 */
export class CoroutineProxy {
  #deferred = new Deferred();
  #queue = new AsyncQueue();

  get promise() {
    return this.#deferred.promise;
  }

  async* generateAsync() {
    while (true) {
      const { value, done } = await this.#queue.read();
      if (done) break;
      yield value;
    }
  }

  async run(getCoroutineGenerator) {
    const proxyGenerator = this.generateAsync();
    this.#deferred.resolve(proxyGenerator[Symbol.asyncIterator]());

    const coroutineGenerator = getCoroutineGenerator();
    for await (const item of coroutineGenerator) {
      this.#queue.write({ value: item, done: false });
    }
    this.#queue.write({ value: null, done: true });
  }
}

/**
 * Class representing a CoroutineProxy
 * AsyncTask wrap a sync/async function as an
 * asynchronous operation with no re-entrancy,
 * i.e. multiple invocations of 'func(token)' will 
 * wait for the previous invocation to complete,
 * respecting errors and cancellation requests via 'token'
 */
export class AsyncOperation {
  #cts = null; // CancellationTokenSource;
  #promise = null; // Promise

  cancel() {
    verifyThis(this, AsyncOperation);    
    this.#cts?.cancel();
  }

  get promise() {
    return this._task;
  }

  async run(func, outerToken) {
    const prevCts = this.#cts;
    const prevPromise = this.#promise;

    // create a CancellationTokenSource linked to token
    const cts = new CancellationTokenSource(outerToken);
    const token = cts.token;
    this.#cts = cts;

    const runner = async () => {
      try {
        // wait for the previous instance to finish,
        prevPromise && await prevPromise;
      }
      catch (e) {
        // ignore cancellation of the previous instance
        CancelledError.throwUnlessCancelled(e);
      }

      // start a new instance
      token.throwIfCancellationRequested();
      return await func(token);
    };

    // new invocation
    const promise = runner();
    this.#promise = promise;

    // cancel the previous invocation if any
    prevCts && prevCts.cancel();

    return await promise;
  }
}

/**
 * Function observeAnyEvent
 */

export async function observeAnyEvent(subscribe, unsubscribe, token, mapEvent) { 
  const deferred = new Deferred();
  const rego = token.register(deferred.cancel);
  try {
    const handler = (...args) => {
      try {
        token.throwIfCancellationRequested();
        deferred.resolve(mapEvent(...args));
      } catch (error) {
        deferred.reject(error);
      }
    };
    const subscription = subscribe(handler);    
    try {
      return await deferred.promise;      
    } 
    finally {
      unsubscribe(subscription);    
    }
  }
  finally {
    rego.unregister();
  }    
}

/**
 * Function streamAnyEvents
 */
export async function* streamAnyEvents(subscribe, unsubscribe, token, mapEvent) {
  const queue = [];
  let deferred = null;
 
  const rego = token.register(() => deferred?.cancel());
  try {
    const handler = (...args) => {
      try {
        token.throwIfCancellationRequested();
        queue.push(Promise.resolve(mapEvent(...args)));
      } catch (error) {
        queue.push(Promise.reject(error));
      }
      deferred?.resolve();
    };

    const subscription = subscribe(handler);
    try {
      while (true) {
        while (queue.length) {
          token.throwIfCancellationRequested();          
          yield await queue.shift();
        }
        deferred = new Deferred();
        await deferred.promise;
        deferred = null;
      }      
    } 
    finally {
      unsubscribe(subscription);
    }
  }
  finally {
    rego.unregister();
  }
}

/**
 * Function observeEvent
 */
export function observeEvent(eventTarget, eventName, token, mapEvent) {
  return observeAnyEvent(
    handler => {
      eventTarget.addEventListener(eventName, handler, { once: true });
      return handler;
    },
    handler => eventTarget.removeEventListener(eventName, handler),
    token,
    event => mapEvent? mapEvent(event): event)
}

/**
 * Function streamEvents
 */
export function streamEvents(eventTarget, eventName, token, mapEvent) {
  return streamAnyEvents(
    handler => {
      eventTarget.addEventListener(eventName, handler);
      return handler;
    },
    handler => eventTarget.removeEventListener(eventName, handler),
    token,
    event => mapEvent? mapEvent(event): event);
}

/**
 * Function observeNodeEvent
 */
export function observeNodeEvent(eventEmitter, eventName, token, mapEvent) {
  return observeAnyEvent(
    handler => {
      eventEmitter.once(eventName, handler);
      return handler;
    },
    handler => eventEmitter.removeListener(eventName, handler),
    token,
    (...args) => mapEvent? mapEvent(...args): eventName);
  }

/**
 * Function streamNodeEvents
 */
export function streamNodeEvents(eventEmitter, eventName, token, mapEvent) {
  return streamAnyEvents(
    handler => {
      eventEmitter.on(eventName, handler);
      return handler;
    },
    handler => eventEmitter.removeListener(eventName, handler),
    token,
    (...args) => mapEvent? mapEvent(...args): eventName);
}

/**
 * Function throwUnlessCancelled
 */
export function throwUnlessCancelled(error, log) {
  return CancelledError.throwUnlessCancelled(error, log);
}

/**
 * Function logWarning
 */
export function logWarning(error) {
  console.warn(error.message);
  return error;
}

/**
 * Function logError
 */
export function logError(error) {
  if (error instanceof AggregateError) {
    for (const e in error.errors) {
      console.error(e);
    }
  }
  else {
    console.error(error);
  }
  return error;
}

/**
 * Function cancelProof
 */
export function cancelProof(error) {
  return throwUnlessCancelled(error, logWarning)
}

/**
 * Function cancelProofLog
 */
export function cancelProofLog(log) {
  return log? 
    error => throwUnlessCancelled(error, log):
    throwUnlessCancelled;
}

/**
 * Function runWithCancellation
 */
export async function runWithCancellation(callback, token) {
  const deferred = new Deferred();
  const rego = token.register(deferred.cancel);
  try {
    Promise.resolve(callback()).then(deferred.resolve, deferred.reject);
    await deferred.promise;
  }
  finally {
    rego.unregister();
  }  
}

/**
 * Function cancelWhenAnyFails
 */
export async function cancelWhenAnyFails(iterable, cancel) {
  const tasks = [...iterable];
  // this bails of any of the promises is rejected
  let succeeded = false;
  await Promise.all(tasks).then(() => succeeded = true, cancel);
  if (succeeded) {
    return;
  }
  // this resolves when any of the promises are either fulfilled or rejected 
  const results = await Promise.allSettled(tasks);
  // make an AggregateError of all errors
  const errors = [];
  let allCancelled = true;
  for (const { reason } of results) {
    if (reason) {
      errors.push(reason);
      allCancelled = allCancelled && reason instanceof CancelledError;
    }
  }
  if (errors.length) {
    throw allCancelled?
      new CancelledError("One or more operations cancelled"):
      new AggregateError(errors);
  }
  // all settled without errors
}

/**
 * Function runWorkflowTask(taskFunc, token)
 */
export async function runWorkflowTask(taskFunc, token) {
  const cts = new CancellationTokenSource(token);
  let succeeded = false;
  try {
    const result = await taskFunc(cts.token);
    succeeded = true;
    return result;
  } 
  finally {
    if (!succeeded) {
      cts.cancel();
    }
    cts.close();
  }
}

// helper
function verifyThis(instance, classType) {
  if (!(instance instanceof classType)) {
    throw new TypeError(`Invalid "this", must be an instance of class "${A.name}"`);
  }
}
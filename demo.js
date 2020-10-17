import * as ta from "./index.js";
import EventEmitter from 'events';
import et from 'internal/event_target';

async function test_Delay() {
  // delay
  var delay = new ta.Delay(500); 
  console.log(delay instanceof ta.Delay);
  await delay;

  console.log("delayed")
}

async function test_Deferred() {
  // deferred
  let d = new ta.Deferred(); setTimeout(() => d.resolve(), 500); await d;
  console.log("resolved")
}

async function test_AsyncQueue() {
  // queue
  let q = new ta.AsyncQueue();
  let p1 = q.read(ta.CancellationToken.none).then(v => v + 0.1);
  let p2 = q.read(ta.CancellationToken.none).then(v => v + 0.2);
  let p3 = q.read(ta.CancellationToken.none).then(v => v + 0.3);
  q.write(1);
  q.write(2);
  q.write(3);
  console.log(await Promise.race([p1, p2, p3]) === 1.1);
  console.log(await Promise.race([p2, p3]) === 2.2);
  console.log(await Promise.race([p3]) === 3.3);
}

async function test_AsyncLock() {
  // async lock
  let asyncLock = new ta.AsyncLock();
  async function work(name) {
    await asyncLock.wait();
    console.log(`${name} enter`);
    try {
      for (let i = 0; i < 3; i++) {
        await new ta.Delay(200);
      }
    }
    finally {
      console.log(`${name} exit`);
      asyncLock.release();
    }
  }

  let p1 = work("work1");
  let p2 = work("work2");
  let p3 = work("work3");
  await Promise.allSettled([p1, p2, p3]);
}

async function test_coroutines() {
  // coroutines
  async function* coroutine1(coroutinePromise) {
    const coroutine = await coroutinePromise;

    yield 1.1;

    let step = await coroutine.next();
    if (step.done) {
      return;
    }
    console.log(step.value);

    yield 1.2;

    step = await coroutine.next();
    if (step.done) {
      return;
    }
    console.log(step.value);

    yield 1.3;

    step = await coroutine.next();
    if (step.done) {
      return;
    }
    console.log(step.value);
  }

  async function* coroutine2(coroutinePromise) {
    const coroutine = await coroutinePromise;

    let step = await coroutine.next();
    if (step.done) {
      return;
    }
    console.log(step.value);

    yield 2.1;

    step = await coroutine.next();
    if (step.done) {
      return;
    }
    console.log(step.value);

    yield 2.2;

    step = await coroutine.next();
    if (step.done) {
      return;
    }
    console.log(step.value);

    yield 2.3;
  }

  let proxy1 = new ta.CoroutineProxy();
  let proxy2 = new ta.CoroutineProxy();

  let p1 = proxy1.run(() => coroutine1(proxy2.promise));
  let p2 = proxy2.run(() => coroutine2(proxy1.promise));
  await Promise.allSettled([p1, p2]);
}

async function test_CancellablePromise() {
  // delayWithCancellation
  function delayWithCancellation(timeoutMs, token) {
    console.log(`delayWithCancellation: ${timeoutMs}`);

    return new ta.CancellablePromise(d => {
      const id = setTimeout(d.resolve, timeoutMs);
      d.token.register(() => {
        console.log("cleared!"); 
        clearTimeout(id);
      });
    }, token);
  }

  const tokenSource = new ta.CancellationTokenSource();
  const token = tokenSource.token;
  setTimeout(() => tokenSource.cancel(), 1500); // cancel after 1500ms

  try {
    await delayWithCancellation(1000, token);
    console.log("successfully delayed."); // we should reach here
  
    await delayWithCancellation(2000, token);
    console.log("successfully delayed."); // we should not reach here  
 
  }
  catch(e) 
  {
    ta.throwUnlessCancelled(e, () => console.log("Cancelled"));
  }
}

function test_CancellationTokenSource() {
  try {
    let cts1 = new ta.CancellationTokenSource();
    cts1.token.register(() => console.log(1.1));
    let r = cts1.token.register(() => console.log(1.2));
    r.unregister();
    cts1.token.register(() => console.log(1.3));

    let cts2 = new ta.CancellationTokenSource(cts1.token);
    cts2.token.register(() => console.log(2.1));
    cts2.token.register(() => console.log(2.2));
    cts2.token.register(() => console.log(2.3));

    let cts3 = new ta.CancellationTokenSource(cts2.token);
    cts3.token.register(() => console.log(3.1));
    cts3.token.register(() => console.log(3.2));
    cts3.token.register(() => console.log(3.3));
    cts3.token.register(() => cts1.close());

    let cts4 = new ta.CancellationTokenSource(cts1.token);
    cts4.token.register(() => console.log(4.1));
    cts4.token.register(() => console.log(4.2));
    cts4.token.register(() => console.log(4.3));

    cts1.cancel();
    cts1.token.register(() => console.log(1.4));

    cts1.token.throwIfCancellationRequested();
  }
  catch(e) 
  {
    ta.throwUnlessCancelled(e);
  }
}

class TimerSource extends et.EventTarget {
  #id = null;
  constructor(interval) {
    super();
    this.#id = setInterval(() => {
      const event = new et.Event("tick");
      this.dispatchEvent(event);
    }, interval);
  }

  close() {
    clearInterval(this.#id);
  }
};

async function test_streamEvents() {
  const timerSource = new TimerSource(100);
  const cts = new ta.CancellationTokenSource();
  setTimeout(() => cts.cancel(), 1000);

  let { type } = await ta.observeEvent(timerSource, "tick", cts.token);  
  console.log(`observeEvent: ${type}`);

  try {
    for await (let event of ta.streamEvents(timerSource, "tick", cts.token)) {
      console.log(event.type);
    }    
  } catch (error) {
    ta.throwUnlessCancelled(error);
  }
  finally {
    timerSource.close();
  }
}

class NodeTimerSource extends EventEmitter {
  #id = null;
  constructor(interval) {
    super();
    this.#id = setInterval(() => {
      const name = "nodeTick";
      this.emit(name, name);
    }, interval);
  }

  close() {
    clearInterval(this.#id);
  }
};

async function test_streamNodeEvents() {
  const timerSource = new NodeTimerSource(100);
  const cts = new ta.CancellationTokenSource();
  setTimeout(() => cts.cancel(), 1000);

  console.log(`observeNodeEvent: ${await ta.observeNodeEvent(timerSource, "nodeTick", cts.token)}`);  

  try {
    for await (let eventName of ta.streamNodeEvents(timerSource, "nodeTick", cts.token)) {
      console.log(eventName);
    }    
  } catch (error) {
    ta.throwUnlessCancelled(error);
  }
  finally {
    timerSource.close();
  }
}

(async function() {
  await test_Delay();
  await test_Deferred();
  await test_AsyncQueue();
  await test_AsyncLock();
  await test_coroutines();
  await test_CancellablePromise();
  await test_CancellationTokenSource();
  await test_streamEvents();
  await test_streamNodeEvents();  
})().catch(error => console.log(error));

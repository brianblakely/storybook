/* eslint-disable no-underscore-dangle */

import { addons, mockChannel } from '@storybook/addons';
import {
  FORCE_REMOUNT,
  SET_CURRENT_STORY,
  STORY_RENDER_PHASE_CHANGED,
} from '@storybook/core-events';
import global from 'global';

import { EVENTS, Instrumenter, Options } from './instrumenter';

const callSpy = jest.fn();
const syncSpy = jest.fn();
const forceRemountSpy = jest.fn();
addons.setChannel(mockChannel());
addons.getChannel().on(EVENTS.CALL, callSpy);
addons.getChannel().on(EVENTS.SYNC, syncSpy);
addons.getChannel().on(FORCE_REMOUNT, forceRemountSpy);

class HTMLElement {
  constructor(props: any) {
    Object.assign(this, props);
  }
}

delete global.window.location;
global.window.location = { reload: jest.fn() };
global.window.HTMLElement = HTMLElement;

const storyId = 'kind--story';
global.window.__STORYBOOK_PREVIEW__ = { urlStore: { selection: { storyId } } };

const setRenderPhase = (newPhase: string) =>
  addons.getChannel().emit(STORY_RENDER_PHASE_CHANGED, { newPhase, storyId });

let instrumenter: Instrumenter;
const instrument = <TObj extends Record<string, any>>(obj: TObj, options: Options = {}) =>
  instrumenter.instrument(obj, options);

beforeEach(() => {
  jest.useRealTimers();
  callSpy.mockClear();
  syncSpy.mockClear();
  forceRemountSpy.mockClear();
  instrumenter = new Instrumenter();
  setRenderPhase('loading');
});

afterEach(() => {
  addons.getChannel().emit(SET_CURRENT_STORY); // trigger a cleanup
});

describe('Instrumenter', () => {
  it('patches object methods', () => {
    const fn = () => {};
    const result = instrument({ fn });
    expect(result).toStrictEqual({ fn: expect.any(Function) });
    expect(result.fn.name).toBe('fn');
    expect(result.fn.__originalFn__).toBe(fn);
  });

  it('patches nested methods', () => {
    const fn1: any = () => {};
    const fn2: any = () => {};
    const result = instrument({ foo: { fn1, bar: { fn2 } } });
    expect(result).toStrictEqual({
      foo: {
        fn1: expect.any(Function),
        bar: { fn2: expect.any(Function) },
      },
    });
    expect(result.foo.fn1.__originalFn__).toBe(fn1);
    expect(result.foo.bar.fn2.__originalFn__).toBe(fn2);
  });

  it('does not patch already patched functions', () => {
    const fn: any = () => {};
    const result = instrument(instrument({ fn }));
    expect(result.fn.__originalFn__).toBe(fn);
    expect(result.fn.__originalFn__.__originalFn__).not.toBeDefined();
  });

  it('does not traverse into arrays', () => {
    const fn1: any = () => {};
    const fn2: any = () => {};
    const result = instrument({ arr: [fn1, { fn2 }] });
    expect(result).toStrictEqual({ arr: [fn1, { fn2 }] });
    expect(result.arr[0].__originalFn__).not.toBeDefined();
    expect(result.arr[1].fn2.__originalFn__).not.toBeDefined();
  });

  it('patches function properties on functions', () => {
    const fn1: any = () => {};
    fn1.fn2 = () => {};
    const result = instrument({ fn1 });
    expect(result.fn1).toEqual(expect.any(Function));
    expect(result.fn1.fn2).toEqual(expect.any(Function));
    expect(result.fn1.__originalFn__).toBe(fn1);
    expect(result.fn1.fn2.__originalFn__).toBe(fn1.fn2);
  });

  it('patched functions call the original function when invoked', () => {
    const { fn } = instrument({ fn: jest.fn() });
    const obj = {};
    fn('foo', obj);
    expect(fn.__originalFn__).toHaveBeenCalledWith('foo', obj);
  });

  it('emits a "call" event every time a patched function is invoked', () => {
    const { fn } = instrument({ fn: (...args: any) => {} });
    fn('foo', 'bar');
    fn('baz');
    expect(callSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'kind--story [0] fn',
        args: ['foo', 'bar'],
      })
    );
    expect(callSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'kind--story [1] fn',
        args: ['baz'],
      })
    );
  });

  it('provides metadata about the call in the event', () => {
    const { obj } = instrument({ obj: { fn: () => {} } });
    obj.fn();
    expect(callSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        path: ['obj'],
        method: 'fn',
        interceptable: false,
        state: 'done',
        parentId: undefined,
      })
    );
  });

  it('maps event args which originate from an earlier call to a call ref', () => {
    const { fn1, fn2 } = instrument({
      fn1: (arg: any) => arg,
      fn2: (arg: any) => {},
    });
    fn2(fn1({}));
    expect(callSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: 'fn2',
        args: [{ __callId__: callSpy.mock.calls[0][0].id, retain: false }],
      })
    );
  });

  it('does not map primitive event args which originate from an earlier call', () => {
    const { fn1, fn2 } = instrument({
      fn1: (...args: any) => args[0],
      fn2: (...args: any) => {},
    });
    fn2(
      fn1(undefined),
      fn1(null),
      fn1(true),
      fn1('foo'),
      fn1(1),
      fn1(BigInt(1)), // eslint-disable-line no-undef
      fn1({}),
      fn1([]),
      fn1(() => {}),
      fn1(Symbol('hi')),
      fn1(new Error('Oops'))
    );
    expect(callSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: 'fn2',
        args: [
          /* call 0 */ undefined,
          /* call 1 */ null,
          /* call 2 */ true,
          /* call 3 */ 'foo',
          /* call 4 */ 1,
          /* call 5 */ BigInt(1), // eslint-disable-line no-undef
          { __callId__: callSpy.mock.calls[6][0].id, retain: false },
          { __callId__: callSpy.mock.calls[7][0].id, retain: false },
          { __callId__: callSpy.mock.calls[8][0].id, retain: false },
          { __callId__: callSpy.mock.calls[9][0].id, retain: false },
          { __callId__: callSpy.mock.calls[10][0].id, retain: false },
        ],
      })
    );
  });

  it('maps HTML Elements in event args to an element ref', () => {
    const { fn } = instrument({ fn: (...args: any) => {} });
    fn(new HTMLElement({ prefix: '', localName: 'div', id: 'root', classList: [] }));
    expect(callSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        args: [{ __element__: { prefix: '', localName: 'div', id: 'root', classNames: [] } }],
      })
    );
  });

  it('tracks the parent call id for calls inside callbacks', () => {
    const fn = (callback?: Function) => callback && callback();
    const { fn1, fn2, fn3, fn4, fn5 } = instrument({ fn1: fn, fn2: fn, fn3: fn, fn4: fn, fn5: fn });
    fn1(() => {
      fn2(() => fn3());
      fn4();
    });
    fn5();
    expect(callSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'kind--story [0] fn1', parentId: undefined })
    );
    expect(callSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'kind--story [1] fn2', parentId: 'kind--story [0] fn1' })
    );
    expect(callSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'kind--story [2] fn3', parentId: 'kind--story [1] fn2' })
    );
    expect(callSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'kind--story [3] fn4', parentId: 'kind--story [0] fn1' })
    );
    expect(callSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'kind--story [4] fn5', parentId: undefined })
    );
  });

  it('tracks the parent call id for async callbacks', async () => {
    const fn = (callback?: Function) => Promise.resolve(callback && callback());
    const { fn1, fn2, fn3 } = instrument({ fn1: fn, fn2: fn, fn3: fn });
    await fn1(() => fn2());
    await fn3();
    expect(callSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'kind--story [0] fn1', parentId: undefined })
    );
    expect(callSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'kind--story [1] fn2', parentId: 'kind--story [0] fn1' })
    );
    expect(callSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'kind--story [2] fn3', parentId: undefined })
    );
  });

  it('instruments the call result to support chaining', () => {
    const { fn1 } = instrument({
      fn1: () => ({
        fn2: () => {},
      }),
    });
    fn1().fn2();
    expect(callSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: 'fn2',
        path: [{ __callId__: callSpy.mock.calls[0][0].id }],
      })
    );
  });

  it('emits a "sync" event with debounce after a patched function is invoked', () => {
    const { fn } = instrument({ fn: (...args: any) => {} }, { intercept: true });
    jest.useFakeTimers();
    syncSpy.mockClear();
    fn('foo');
    fn('bar');
    jest.runAllTimers();
    expect(syncSpy).toHaveBeenCalledTimes(1);
  });

  it('sends a folded log with the "sync" event', () => {
    const { fn } = instrument({ fn: (...args: any) => ({ fn2: () => {} }) }, { intercept: true });
    jest.useFakeTimers();
    fn('foo', fn('bar')).fn2();
    fn('baz');
    jest.runAllTimers();
    expect(syncSpy).toHaveBeenCalledWith([
      { callId: 'kind--story [2] fn2', state: 'done' },
      { callId: 'kind--story [3] fn', state: 'done' },
    ]);
  });

  it('catches thrown errors and returns the error', () => {
    const { fn } = instrument({
      fn: () => {
        throw new Error('Boom!');
      },
    });
    expect(fn()).toEqual(new Error('Boom!'));
    expect(() => setRenderPhase('played')).toThrow(new Error('Boom!'));
  });

  it('forwards nested exceptions', () => {
    const { fn1, fn2 } = instrument({
      fn1: (...args: any) => {}, // doesn't forward args
      fn2: () => {
        throw new Error('Boom!');
      },
    });
    expect(fn1(fn2())).toEqual(new Error('Boom!'));
    expect(() => setRenderPhase('played')).toThrow(new Error('Boom!'));
  });

  it("re-throws anything that isn't an error", () => {
    const { fn } = instrument({
      fn: () => {
        throw 'Boom!'; // eslint-disable-line no-throw-literal
      },
    });
    expect(fn).toThrow('Boom!');
    expect(callSpy).not.toHaveBeenCalled();
  });

  it('does not affect intercepted methods', () => {
    const { fn } = instrument({ fn: jest.fn() }, { intercept: true });
    fn('foo');
    expect(fn.__originalFn__).toHaveBeenCalledWith('foo');
  });

  it('clears state when switching stories', () => {
    addons.getChannel().emit(SET_CURRENT_STORY); // initialization
    instrumenter.state = {
      'kind--story': {
        isDebugging: false,
        cursor: 123,
        calls: [{ id: 'kind--story [0] fn' }],
        shadowCalls: [{ id: 'kind--story [0] fn' }, { id: 'kind--story [1] fn' }],
        callRefsByResult: new Map([[{}, 'ref']]),
        chainedCallIds: new Set(['kind--story [0] fn']),
        parentCall: { id: 'kind--story [0] fn' },
        playUntil: 'kind--story [1] fn',
        resolvers: { ref: () => {} },
        syncTimeout: 123,
        forwardedException: new Error('Oops'),
      },
    } as any;
    addons.getChannel().emit(SET_CURRENT_STORY);
    expect(instrumenter.state).toStrictEqual({});
  });

  describe('with intercept: true', () => {
    const options = { intercept: true };

    it('emits a call event with exception metadata when the function throws', () => {
      const { fn } = instrument(
        {
          fn: () => {
            throw new Error('Boom!');
          },
        },
        options
      );
      expect(fn).toThrow();
      expect(callSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'kind--story [0] fn',
          exception: {
            name: 'Error',
            message: 'Boom!',
            stack: expect.stringContaining('Error: Boom!'),
            callId: 'kind--story [0] fn',
          },
        })
      );
    });

    it('catches thrown errors and throws an ignoredException instead', () => {
      const { fn } = instrument(
        {
          fn: () => {
            throw new Error('Boom!');
          },
        },
        options
      );
      expect(fn).toThrow('ignoredException');
    });

    it('catches forwarded exceptions and throws an ignoredException instead', () => {
      const { fn1, fn2 } = instrument(
        {
          fn1: (_: any) => {},
          fn2: () => {
            throw new Error('Boom!');
          },
        },
        options
      );
      expect(() => fn1(fn2())).toThrow('ignoredException');
    });
  });

  describe('while debugging', () => {
    afterEach(() => {
      addons.getChannel().emit(EVENTS.END, { storyId });
    });

    it('remounts on the "start" event', async () => {
      addons.getChannel().emit(EVENTS.START, { storyId });
      expect(forceRemountSpy).toHaveBeenCalled();
    });

    it('defers calls to intercepted functions', () => {
      const { fn } = instrument({ fn: jest.fn() }, { intercept: true });
      addons.getChannel().emit(EVENTS.START, { storyId });
      expect(fn()).toEqual(expect.any(Promise));
      expect(fn.__originalFn__).not.toHaveBeenCalled();
    });

    it('does not defer calls to non-intercepted functions', () => {
      const { fn } = instrument({ fn: jest.fn(() => 'ok') });
      addons.getChannel().emit(EVENTS.START, { storyId });
      expect(fn()).toBe('ok');
      expect(fn.__originalFn__).toHaveBeenCalled();
    });

    it('does not defer calls to intercepted functions that are chained upon', () => {
      const { fn1 } = instrument(
        { fn1: jest.fn(() => ({ fn2: jest.fn() as any })) },
        { intercept: true }
      );
      fn1().fn2();
      addons.getChannel().emit(EVENTS.START, { storyId });
      const res1 = fn1();
      expect(res1.fn2()).toEqual(expect.any(Promise));
      expect(fn1.__originalFn__).toHaveBeenCalledTimes(2);
      expect(res1.fn2.__originalFn__).not.toHaveBeenCalled();
    });

    it.skip('starts debugging at the first non-nested interceptable call', () => {
      const { fn } = instrument({ fn: jest.fn((...args: any) => args) }, { intercept: true });
      fn(fn(), fn()); // setup the dependencies
      addons.getChannel().emit(EVENTS.START, { storyId });
      const a = fn('a');
      const b = fn('b');
      const c = fn(a, b);
      expect(a).toEqual(['a']);
      expect(b).toEqual(['b']);
      expect(c).toEqual(expect.any(Promise));
    });

    it('steps through each interceptable function on "next"', async () => {
      const fn = jest.fn();
      const { fn: instrumentedFn } = instrument({ fn }, { intercept: true });

      const mockedInstrumentedFn = jest.fn(instrumentedFn);
      const play = async () => {
        await mockedInstrumentedFn();
        await mockedInstrumentedFn();
        await mockedInstrumentedFn();
      };

      await play();
      fn.mockClear();
      mockedInstrumentedFn.mockClear();

      addons.getChannel().emit(EVENTS.START, { storyId });

      const p = play();
      expect(mockedInstrumentedFn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledTimes(0);

      addons.getChannel().emit(EVENTS.NEXT, { storyId });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mockedInstrumentedFn).toHaveBeenCalledTimes(2);
      expect(fn).toHaveBeenCalledTimes(1);

      addons.getChannel().emit(EVENTS.END, { storyId });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mockedInstrumentedFn).toHaveBeenCalledTimes(3);
      expect(fn).toHaveBeenCalledTimes(3);

      await p;
    });
  });
});

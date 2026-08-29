// crypto polyfill — MUST be the very first import (before any core/lib code)
import "react-native-get-random-values";
import * as ExpoCrypto from "expo-crypto";

import { registerRootComponent } from "expo";
import TrackPlayer from "react-native-track-player";
import App from "./src/App";
import { PlaybackService } from "./src/services/PlaybackService";


// PERF-PROBE: Hermes CPU sampling profiler — 抓 JS 线程热函数 (90s 自动停止)。
// stop() 后 logcat 输出保存路径(cpuprofile),pull 回来分析。
globalThis.__perfSamplerStarted =
  globalThis.__perfSamplerStarted ||
  (function () {
    try {
      var Sampler = require("HermesSamplingProfiler");
      Sampler.start();
      console.log("[PERF] sampler started");
      setTimeout(function () {
        try {
          Sampler.stop().then(function (result) {
            console.log("[PERF] sampler stopped: " + JSON.stringify(result || {}).slice(0, 200));
          });
        } catch (e) {
          console.log("[PERF] sampler stop err " + e);
        }
      }, 90000);
    } catch (e) {
      console.log("[PERF] sampler NOT available: " + e);
    }
  })();

function bytesToString(bytes) {
  if (typeof TextDecoder !== "undefined") {
    return new TextDecoder().decode(bytes);
  }

  let result = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    result += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return result;
}

function hexToArrayBuffer(hex) {
  const normalized = hex.trim();
  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < normalized.length; i += 2) {
    bytes[i / 2] = Number.parseInt(normalized.slice(i, i + 2), 16);
  }
  return bytes.buffer;
}

function resolveDigestAlgorithm(algorithm) {
  const name = typeof algorithm === "string" ? algorithm : algorithm?.name;
  switch ((name || "").toUpperCase()) {
    case "SHA-1":
      return ExpoCrypto.CryptoDigestAlgorithm.SHA1;
    case "SHA-256":
      return ExpoCrypto.CryptoDigestAlgorithm.SHA256;
    default:
      throw new Error(`Unsupported digest algorithm: ${String(name || algorithm)}`);
  }
}

function toUint8Array(data) {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  throw new TypeError("subtle.digest expects an ArrayBuffer or TypedArray");
}

const cryptoObject = globalThis.crypto ?? {};
if (!globalThis.crypto) {
  globalThis.crypto = cryptoObject;
}

if (!cryptoObject.subtle) {
  Object.defineProperty(cryptoObject, "subtle", {
    configurable: true,
    enumerable: true,
    value: {
      async digest(algorithm, data) {
        return ExpoCrypto.digest(resolveDigestAlgorithm(algorithm), toUint8Array(data));
      },
    },
  });
}

registerRootComponent(App);
TrackPlayer.registerPlaybackService(() => PlaybackService);

import { describe, expect, test } from 'bun:test'
import type { logs } from '@opentelemetry/api-logs'
import type { LoggerProvider } from '@opentelemetry/sdk-logs'
import type { MeterProvider } from '@opentelemetry/sdk-metrics'
import type { BasicTracerProvider } from '@opentelemetry/sdk-trace-base'
import { resetStateForTests } from 'src/bootstrap/state.js'
import {
  getEventLogger,
  getLoggerProvider,
  getMeterProvider,
  getTracerProvider,
  setEventLogger,
  setLoggerProvider,
  setMeterProvider,
  setTracerProvider,
} from 'src/services/observability/providers.js'

describe('observability providers store', () => {
  test('resetStateForTests clears provider storage outside bootstrap state', () => {
    setLoggerProvider({} as LoggerProvider)
    setMeterProvider({} as MeterProvider)
    setTracerProvider({} as BasicTracerProvider)
    setEventLogger({ emit() {} } as ReturnType<typeof logs.getLogger>)

    expect(getLoggerProvider()).not.toBeNull()
    expect(getMeterProvider()).not.toBeNull()
    expect(getTracerProvider()).not.toBeNull()
    expect(getEventLogger()).not.toBeNull()

    resetStateForTests()

    expect(getLoggerProvider()).toBeNull()
    expect(getMeterProvider()).toBeNull()
    expect(getTracerProvider()).toBeNull()
    expect(getEventLogger()).toBeNull()
  })
})

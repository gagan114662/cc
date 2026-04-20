import type { logs } from '@opentelemetry/api-logs'
import type { LoggerProvider } from '@opentelemetry/sdk-logs'
import type { MeterProvider } from '@opentelemetry/sdk-metrics'
import type { BasicTracerProvider } from '@opentelemetry/sdk-trace-base'

let loggerProvider: LoggerProvider | null = null
let eventLogger: ReturnType<typeof logs.getLogger> | null = null
let meterProvider: MeterProvider | null = null
let tracerProvider: BasicTracerProvider | null = null

export function getLoggerProvider(): LoggerProvider | null {
  return loggerProvider
}

export function setLoggerProvider(provider: LoggerProvider | null): void {
  loggerProvider = provider
}

export function getEventLogger(): ReturnType<typeof logs.getLogger> | null {
  return eventLogger
}

export function setEventLogger(
  logger: ReturnType<typeof logs.getLogger> | null,
): void {
  eventLogger = logger
}

export function getMeterProvider(): MeterProvider | null {
  return meterProvider
}

export function setMeterProvider(provider: MeterProvider | null): void {
  meterProvider = provider
}

export function getTracerProvider(): BasicTracerProvider | null {
  return tracerProvider
}

export function setTracerProvider(provider: BasicTracerProvider | null): void {
  tracerProvider = provider
}

export function resetObservabilityProvidersForTests(): void {
  loggerProvider = null
  eventLogger = null
  meterProvider = null
  tracerProvider = null
}

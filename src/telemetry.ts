/* eslint-disable @typescript-eslint/no-explicit-any */
import { performance } from 'perf_hooks';
import type { Struct, Blank } from './back-end';

/**
 * Metric data point
 *
 * @export
 * @typedef {Metric}
 */
export interface Metric {
	name: string;
	value: number;
	timestamp: number;
	tags: Record<string, string>;
}

/**
 * Distributed tracing span
 *
 * @export
 * @typedef {Span}
 */
export interface Span {
	name: string;
	startTime: number;
	endTime?: number;
	duration?: number;
	tags: Record<string, string>;
	events: Array<{ name: string; timestamp: number; attributes?: Record<string, any> }>;
}

/**
 * Telemetry configuration
 *
 * @export
 * @typedef {TelemetryConfig}
 */
export interface TelemetryConfig {
	serviceName: string;
	metricsEndpoint?: string;
	tracesEndpoint?: string;
	sampleRate?: number;
}

/**
 * Telemetry and metrics for struct operations
 *
 * @export
 * @class StructTelemetry
 * @typedef {StructTelemetry}
 * @template T
 * @template Name
 */
export class StructTelemetry<T extends Blank, Name extends string> {
	private metricsBuffer: Metric[] = [];
	private spans: Map<string, Span> = new Map();
	private flushInterval = 10000;
	private maxBufferSize = 1000;
	private config: Required<TelemetryConfig>;
	private flushTimer?: NodeJS.Timeout;

	/**
	 * Creates an instance of StructTelemetry.
	 *
	 * @constructor
	 * @param {Struct<T, Name>} struct
	 * @param {TelemetryConfig} config
	 */
	constructor(
		private struct: Struct<T, Name>,
		config: TelemetryConfig
	) {
		this.config = {
			serviceName: config.serviceName,
			metricsEndpoint: config.metricsEndpoint ?? '',
			tracesEndpoint: config.tracesEndpoint ?? '',
			sampleRate: config.sampleRate ?? 0.1
		};

		this.setupMetrics();
		this.startFlushInterval();
	}

	/**
	 * Sets up automatic metric collection from struct events
	 *
	 * @private
	 */
	private setupMetrics(): void {
		this.struct.on('create', (data) => {
			this.recordMetric('struct.create', 1, {
				struct: this.struct.name,
				source: (data.metadata.get('source') as string) || 'unknown'
			});
		});

		this.struct.on('update', ({ from, to }) => {
			this.recordMetric('struct.update', 1, {
				struct: this.struct.name
			});

			const changedFields = Object.keys(to.data).filter((key) => from.data[key] !== to.data[key]);

			this.recordMetric('struct.update.fields', changedFields.length, {
				struct: this.struct.name,
				fields: changedFields.join(',')
			});
		});

		this.struct.on('error', (error) => {
			this.recordMetric('struct.error', 1, {
				struct: this.struct.name,
				error: error.message
			});
		});
	}

	/**
	 * Records a metric
	 *
	 * @param {string} name
	 * @param {number} value
	 * @param {Record<string, string>} [tags={}]
	 */
	recordMetric(name: string, value: number, tags: Record<string, string> = {}): void {
		const metric: Metric = {
			name,
			value,
			timestamp: Date.now(),
			tags: {
				service: this.config.serviceName,
				...tags
			}
		};

		this.metricsBuffer.push(metric);

		if (this.metricsBuffer.length >= this.maxBufferSize) {
			this.flush();
		}
	}

	/**
	 * Starts a new distributed tracing span
	 *
	 * @param {string} name
	 * @param {Record<string, string>} [tags={}]
	 * @returns {string}
	 */
	startSpan(name: string, tags: Record<string, string> = {}): string {
		const spanId = `${name}-${Date.now()}-${Math.random()}`;

		this.spans.set(spanId, {
			name,
			startTime: performance.now(),
			tags: {
				service: this.config.serviceName,
				struct: this.struct.name,
				...tags
			},
			events: []
		});

		return spanId;
	}

	/**
	 * Adds an event to a span
	 *
	 * @param {string} spanId
	 * @param {string} name
	 * @param {?Record<string, any>} [attributes]
	 */
	addSpanEvent(spanId: string, name: string, attributes?: Record<string, any>): void {
		const span = this.spans.get(spanId);
		if (span) {
			span.events.push({
				name,
				timestamp: performance.now(),
				attributes
			});
		}
	}

	/**
	 * Ends a span
	 *
	 * @param {string} spanId
	 * @param {?Record<string, any>} [tags]
	 */
	endSpan(spanId: string, tags?: Record<string, any>): void {
		const span = this.spans.get(spanId);
		if (span) {
			span.endTime = performance.now();
			span.duration = span.endTime - span.startTime;

			if (tags) {
				Object.assign(span.tags, tags);
			}

			this.sendTrace(span);
			this.spans.delete(spanId);
		}
	}

	/**
	 * Flushes metrics buffer
	 *
	 * @private
	 * @async
	 * @returns {Promise<void>}
	 */
	private async flush(): Promise<void> {
		if (this.metricsBuffer.length === 0) return;

		const toSend = [...this.metricsBuffer];
		this.metricsBuffer = [];

		if (this.config.metricsEndpoint) {
			try {
				await fetch(this.config.metricsEndpoint, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ metrics: toSend })
				});
			} catch (error) {
				console.error('Failed to send metrics:', error);
			}
		}

		this.logAggregatedMetrics(toSend);
	}

	/**
	 * Logs aggregated metrics
	 *
	 * @private
	 * @param {Metric[]} metrics
	 */
	private logAggregatedMetrics(metrics: Metric[]): void {
		const aggregated = new Map<
			string,
			{ count: number; sum: number; min: number; max: number }
		>();

		for (const metric of metrics) {
			const key = `${metric.name}:${JSON.stringify(metric.tags)}`;
			const existing = aggregated.get(key) || {
				count: 0,
				sum: 0,
				min: Infinity,
				max: -Infinity
			};

			existing.count++;
			existing.sum += metric.value;
			existing.min = Math.min(existing.min, metric.value);
			existing.max = Math.max(existing.max, metric.value);

			aggregated.set(key, existing);
		}

		for (const [key, stats] of aggregated) {
			const avg = stats.sum / stats.count;
			this.struct.log(
				`Metric ${key}: count=${stats.count}, avg=${avg.toFixed(2)}, min=${stats.min}, max=${stats.max}`
			);
		}
	}

	/**
	 * Sends trace to endpoint
	 *
	 * @private
	 * @async
	 * @param {Span} span
	 * @returns {Promise<void>}
	 */
	private async sendTrace(span: Span): Promise<void> {
		if (this.config.tracesEndpoint) {
			try {
				await fetch(this.config.tracesEndpoint, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						traceId: `${this.config.serviceName}-${Date.now()}`,
						spans: [span]
					})
				});
			} catch (error) {
				console.error('Failed to send trace:', error);
			}
		}
	}

	/**
	 * Starts the flush interval
	 *
	 * @private
	 */
	private startFlushInterval(): void {
		this.flushTimer = setInterval(() => {
			this.flush();
		}, this.flushInterval);
	}

	/**
	 * Gets telemetry statistics
	 *
	 * @returns {{ metricsBuffered: number; activeSpans: number; recentMetrics: Metric[] }}
	 */
	getStats() {
		return {
			metricsBuffered: this.metricsBuffer.length,
			activeSpans: this.spans.size,
			recentMetrics: this.metricsBuffer.slice(-10)
		};
	}

	/**
	 * Destroys the telemetry instance
	 */
	destroy(): void {
		if (this.flushTimer) {
			clearInterval(this.flushTimer);
		}
		this.flush();
	}
}

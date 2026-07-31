/**
 * The single response envelope used by every route.
 *
 * Success: { success: true, data, requestId, serverTime }
 * Failure: { success: false, error: {...}, requestId, serverTime }
 */
import { AppError, type ErrorCode, isRecoverable } from './errors.ts';

export interface SuccessEnvelope<T> {
  success: true;
  data: T;
  requestId: string;
  serverTime: string;
}

export interface ErrorEnvelope {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
    recoverable: boolean;
    details: unknown;
  };
  requestId: string;
  serverTime: string;
}

export interface PageMeta {
  total: number | null;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface Paged<T> {
  items: T[];
  page: PageMeta;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function ok<T>(data: T, requestId: string): SuccessEnvelope<T> {
  return { success: true, data, requestId, serverTime: nowIso() };
}

export function paged<T>(items: T[], meta: PageMeta, requestId: string): SuccessEnvelope<Paged<T>> {
  return ok({ items, page: meta }, requestId);
}

export function fail(err: AppError, requestId: string): ErrorEnvelope {
  return {
    success: false,
    error: {
      code: err.code,
      message: err.message,
      recoverable: err.recoverable,
      details: err.details ?? null,
    },
    requestId,
    serverTime: nowIso(),
  };
}

export function failCode(
  code: ErrorCode,
  message: string,
  requestId: string,
  details?: unknown,
): ErrorEnvelope {
  return {
    success: false,
    error: { code, message, recoverable: isRecoverable(code), details: details ?? null },
    requestId,
    serverTime: nowIso(),
  };
}

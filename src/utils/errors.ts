export class OrganizationAllowListViolationError extends Error {
	constructor(message: string) {
		super(message)
	}
}

/**
 * Returns the `message` of a thrown value when it carries a string `message`
 * (Error instances and error-like objects), otherwise `undefined`.
 */
export function getThrownMessage(value: unknown): string | undefined {
	if (typeof value === "object" && value !== null && "message" in value && typeof value.message === "string") {
		return value.message
	}
	return undefined
}

/**
 * Message of a thrown value. Error instances and error-like objects yield their
 * `message`; any other thrown value (string, number, undefined, ...) yields `String(value)`.
 */
export function errorMessage(value: unknown): string {
	return getThrownMessage(value) ?? String(value)
}

/** Returns the same instance for `Error`s; wraps any other thrown value in a new `Error`. */
export function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(errorMessage(value))
}

/** Returns a string or numeric `code` property of a thrown value, otherwise `undefined`. */
export function getErrorCode(value: unknown): string | number | undefined {
	if (typeof value === "object" && value !== null && "code" in value) {
		const code = value.code
		if (typeof code === "string" || typeof code === "number") {
			return code
		}
	}
	return undefined
}

/** Returns a string `name` property of a thrown value, otherwise `undefined`. */
export function getErrorName(value: unknown): string | undefined {
	if (typeof value === "object" && value !== null && "name" in value && typeof value.name === "string") {
		return value.name
	}
	return undefined
}

import { errorMessage, getErrorCode, getErrorName, getThrownMessage, toError } from "../errors"

describe("error helpers", () => {
	describe("getThrownMessage", () => {
		it("reads the message of Error instances and error-like objects", () => {
			expect(getThrownMessage(new Error("boom"))).toBe("boom")
			expect(getThrownMessage({ message: "plain" })).toBe("plain")
		})

		it("returns undefined when there is no string message", () => {
			expect(getThrownMessage("text")).toBeUndefined()
			expect(getThrownMessage(undefined)).toBeUndefined()
			expect(getThrownMessage(null)).toBeUndefined()
			expect(getThrownMessage({ message: 42 })).toBeUndefined()
			expect(getThrownMessage({})).toBeUndefined()
		})
	})

	describe("errorMessage", () => {
		it("returns the message for Error instances, including empty messages", () => {
			expect(errorMessage(new Error("boom"))).toBe("boom")
			expect(errorMessage(new Error(""))).toBe("")
		})

		it("falls back to String(value) for non-Error throws", () => {
			expect(errorMessage("text")).toBe("text")
			expect(errorMessage(42)).toBe("42")
			expect(errorMessage(undefined)).toBe("undefined")
			expect(errorMessage(null)).toBe("null")
		})
	})

	describe("toError", () => {
		it("returns the same Error instance", () => {
			const error = new TypeError("boom")
			expect(toError(error)).toBe(error)
		})

		it("wraps non-Error values", () => {
			const wrapped = toError("text")
			expect(wrapped).toBeInstanceOf(Error)
			expect(wrapped.message).toBe("text")
			expect(toError({ message: "plain" }).message).toBe("plain")
		})
	})

	describe("getErrorCode", () => {
		it("reads string and numeric codes", () => {
			expect(getErrorCode(Object.assign(new Error("x"), { code: "ENOENT" }))).toBe("ENOENT")
			expect(getErrorCode({ code: 404 })).toBe(404)
		})

		it("returns undefined otherwise", () => {
			expect(getErrorCode(new Error("x"))).toBeUndefined()
			expect(getErrorCode({ code: {} })).toBeUndefined()
			expect(getErrorCode("ENOENT")).toBeUndefined()
			expect(getErrorCode(undefined)).toBeUndefined()
		})
	})

	describe("getErrorName", () => {
		it("reads string names", () => {
			expect(getErrorName(new TypeError("x"))).toBe("TypeError")
			expect(getErrorName({ name: "TimeoutError" })).toBe("TimeoutError")
		})

		it("returns undefined otherwise", () => {
			expect(getErrorName({ name: 1 })).toBeUndefined()
			expect(getErrorName(null)).toBeUndefined()
		})
	})
})

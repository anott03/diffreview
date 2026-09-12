import { Option, Schema, flow } from "effect";

export const errMessage = flow(
  Schema.decodeUnknownOption(Schema.Union([
    Schema.instanceOf(Error).pipe(Schema.check(Schema.makeFilter((error) => Boolean(error.message)))),
    Schema.Struct({ message: Schema.NonEmptyString }),
    Schema.Struct({ cause: Schema.instanceOf(Error) })
  ])),
  Option.match({
    onNone: () => "internal error",
    onSome: (error) => "message" in error ? error.message : error.cause.message || "internal error"
  })
);

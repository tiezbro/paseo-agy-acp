import { BinaryReader } from "@bufbuild/protobuf/wire";

type FieldHandlers<T> = Record<number, (message: T, reader: BinaryReader) => void>;

/**
 * Walk a length-delimited protobuf message, dispatching each field to its
 * handler by field number and skipping anything unrecognized (unknown fields,
 * future additions we don't care about).
 */
export function readMessage<T>(bytes: Uint8Array, base: T, fields: FieldHandlers<T>): T {
  const reader = new BinaryReader(bytes);
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    const handler = fields[tag >>> 3];
    if (handler) {
      handler(base, reader);
    } else {
      reader.skip(tag & 7);
    }
  }
  return base;
}

/** Read a length-delimited submessage field and decode it with `decode`. */
export function readSubmessage<T>(reader: BinaryReader, decode: (bytes: Uint8Array) => T): T {
  return decode(reader.bytes());
}

/** Convert a protobuf varint field to a JS number, guarding against precision loss. */
export function readInt(reader: BinaryReader): number {
  const value = reader.int64();
  const num = Number(value);
  if (!Number.isSafeInteger(num)) {
    throw new Error(`protobuf int64 field out of safe integer range: ${value}`);
  }
  return num;
}

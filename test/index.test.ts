import { inject, InvalidParametersError } from "../lib/index";
import ssm from "./ssm";

it("should not modify items not matching filters", async () => {
  const obj: any = {
    "param:ssm:name": "/letter",
    "pathparam:ssm:path": "/nested",
    a: "a",
    b: { foo: "foo" }
  };
  await inject(ssm(), obj);
  expect(obj.a).toEqual("a");
  expect(obj.b).toEqual({ foo: "foo" });
});

describe("options", () => {
  it("should not modify input when mutate option is false", async () => {
    const obj: any = {
      "foo:ssm:name": "/letter"
    };
    const result = await inject(ssm(), obj, { mutate: false });
    expect(obj["foo:ssm:name"]).toEqual("/letter");
    expect(result.foo).toEqual("c");
  });

  it("should use provided ItemParser", async () => {
    const obj: any = {
      foo: "/letter"
    };
    await inject(ssm(), obj, {
      itemParser: (key, value, action) => {
        action.addByNameEntry(key, value);
      }
    });
    expect(obj.foo).toEqual("c");
  });
});

describe("parameters by name", () => {
  it("should expand parameters using string values", async () => {
    const obj: any = { "foo:ssm:name": "/letter" };
    await inject(ssm(), obj);
    expect(obj.foo).toEqual("c");
  });

  it("should expand parameters using object values", async () => {
    const obj: any = { "foo:ssm": { name: "/letter" } };
    await inject(ssm(), obj);
    expect(obj.foo).toEqual("c");
  });

  it("should expand parameters with version", async () => {
    const obj = {
      "foo1:ssm:name": "/letter:1",
      "foo2:ssm:name": "/letter:2",
      "foo3:ssm:name": "/letter:3"
    };
    await inject(ssm(), obj);
    expect(obj).toEqual({ foo1: "a", foo2: "b", foo3: "c" });
  });

  it("should decrypt parameters", async () => {
    const obj: any = { "foo:ssm:name": "/encrypted" };
    await inject(ssm(), obj);
    expect(obj.foo).toEqual("foo");
  });

  it("should return an array for StringList parameters", async () => {
    const obj: any = { "foo:ssm:name": "/list" };
    await inject(ssm(), obj);
    expect(obj.foo).toEqual(["a", "b", "c"]);
  });

  it("should call GetParameters with at most 10 parameter names", async () => {
    const client = ssm();
    const obj: any = {};
    const expected: { [key: string]: string } = {};
    for (let i = 0; i < 100; i++) {
      obj[`param${i}:ssm:name`] = `/nested/param${i}`;
      expected[`param${i}`] = `value${i}`;
    }
    await inject(client, obj);
    expect(obj).toEqual(expected);
    expect(client.getParameters).toHaveBeenCalledTimes(10);
  });

  it("should throw InvalidParametersError on error", async () => {
    const obj: any = { "foo:ssm:name": "/bar" };
    await expect(inject(ssm(), obj)).rejects.toThrowError(
      new InvalidParametersError(["/bar"])
    );
  });
});

describe("parameters by path", () => {
  it("should expand paths using string values", async () => {
    const obj: any = { "foo:ssm:path": "/" };
    await inject(ssm(), obj);
    expect(Object.keys(obj.foo)).toEqual(["encrypted", "letter", "list"]);
  });

  it("should expand paths using object values", async () => {
    const obj: any = { "foo:ssm": { path: "/" } };
    await inject(ssm(), obj);
    expect(Object.keys(obj.foo)).toEqual(["encrypted", "letter", "list"]);
  });

  it("should decrypt parameters", async () => {
    const obj: any = { "foo:ssm:path": "/" };
    await inject(ssm(), obj);
    expect(obj.foo.encrypted).toEqual("foo");
  });

  it("should return an array for StringList parameters", async () => {
    const obj: any = { "foo:ssm:path": "/" };
    await inject(ssm(), obj);
    expect(obj.foo.list).toEqual(["a", "b", "c"]);
  });

  it("should expand paths recursively when specified", async () => {
    const obj: any = { "foo:ssm": { path: "/", recursive: true } };
    const nestedKeys: string[] = ["doublenested"];
    for (let i = 0; i < 100; i++) {
      nestedKeys.push(`param${i}`);
    }
    await inject(ssm(), obj);
    expect(Object.keys(obj.foo)).toEqual([
      "encrypted",
      "letter",
      "list",
      "nested"
    ]);
    expect(Object.keys(obj.foo.nested)).toEqual(nestedKeys);
  });

  it("should expand paths equally ending or not with '/'", async () => {
    const obj1 = { "foo:ssm": { path: "/nested", recursive: true } };
    const obj2 = { "foo:ssm": { path: "/nested/", recursive: true } };
    await inject(ssm(), obj1);
    await inject(ssm(), obj2);
    expect(obj1).toEqual(obj2);
  });

  it("should expand paths using pagination", async () => {
    const client = ssm();
    const obj: any = { "foo:ssm": { path: "/nested", recursive: true } };
    await inject(client, obj);
    // 21 => Mocked SSM returns 5 results at most per request
    expect(client.getParametersByPath).toHaveBeenCalledTimes(21);
  });
});

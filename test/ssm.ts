import SSM from "aws-sdk/clients/ssm";

const params: { [key: string]: [SSM.Types.ParameterType, string[]] } = {
  "/encrypted": ["SecureString", ["foo"]],
  "/letter": ["String", ["a", "b", "c"]],
  "/list": ["StringList", ["a,b,c"]],
  "/nested/doublenested/letter": ["String", ["a"]]
};

for (let i = 0; i < 100; i++) {
  params[`/nested/param${i}`] = ["String", [`value${i}`]];
}

const getParameter = (
  request: SSM.Types.GetParameterRequest
): SSM.Types.Parameter => {
  const [Name, selector] = request.Name.split(":");
  const Selector = selector ? `:${selector}` : undefined;

  if (selector && !Number.parseInt(selector)) {
    throw new Error("InvalidKeyId");
  }

  const p = params[Name];
  if (!p) {
    throw new Error(`ParameterNotFound: ${request.Name}`);
  }

  const [Type, versionedValues] = p;
  const Version = selector ? Number.parseInt(selector) : versionedValues.length;
  const value = p[1][Version - 1];

  if (!value) {
    throw new Error(`ParameterVersionNotFound: ${request.Name}`);
  }

  const Value =
    Type === "SecureString" && !request.WithDecryption
      ? new Buffer(value).toString("base64")
      : value;

  return {
    Name,
    Type,
    Value,
    Version,
    Selector
  };
};

const getParameters = (
  request: SSM.Types.GetParametersRequest
): SSM.Types.GetParametersResult => {
  const InvalidParameters: string[] = [];
  const Parameters: SSM.Types.Parameter[] = [];

  for (const name of request.Names) {
    try {
      Parameters.push(
        getParameter({
          Name: name,
          WithDecryption: request.WithDecryption
        })
      );
    } catch {
      InvalidParameters.push(name);
    }
  }

  return { Parameters, InvalidParameters };
};

const getParametersByPath = (
  request: SSM.Types.GetParametersByPathRequest
): SSM.Types.GetParametersByPathResult => {
  if (!request.Path.startsWith("/")) {
    throw new Error(`InvaliPath: ${request.Path}`);
  }
  let NextToken: string | undefined;
  const path = request.Path.endsWith("/") ? request.Path : `${request.Path}/`;
  const maxResults = request.MaxResults || 5;
  const regex = new RegExp(request.Recursive ? `^${path}.+` : `^${path}[^/]+$`);
  const names = Object.keys(params).filter(regex.test.bind(regex));

  if (request.NextToken) {
    const init = new Buffer(request.NextToken, "base64").toString();
    const initIndex = names.indexOf(init);
    if (initIndex < 0) {
      throw new Error("InvalidNextToken");
    }
    names.splice(0, initIndex);
  }

  if (names.length > maxResults) {
    NextToken = new Buffer(names[maxResults]).toString("base64");
    names.splice(maxResults, names.length - maxResults);
  }

  const { Parameters } = getParameters({
    Names: names,
    WithDecryption: request.WithDecryption
  });

  return { Parameters, NextToken };
};

export default (): SSM => {
  const client = new SSM();

  client.getParameter = jest
    .fn()
    .mockImplementation((r: SSM.Types.GetParameterRequest) => {
      return {
        promise: () => Promise.resolve(getParameter(r))
      };
    });

  client.getParameters = jest
    .fn()
    .mockImplementation((r: SSM.Types.GetParametersRequest) => {
      return {
        promise: () => Promise.resolve(getParameters(r))
      };
    });

  client.getParametersByPath = jest
    .fn()
    .mockImplementation((r: SSM.Types.GetParametersByPathRequest) => {
      return {
        promise: () => Promise.resolve(getParametersByPath(r))
      };
    });

  return client;
};

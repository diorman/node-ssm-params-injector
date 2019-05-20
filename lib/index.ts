const GET_PARAMETERS_LIMIT = 10;

interface SSM {
  getParameters(
    params: SSM.GetParametersRequest
  ): SSM.Request<SSM.GetParametersResult>;

  getParametersByPath(
    params: SSM.GetParametersByPathRequest
  ): SSM.Request<SSM.GetParametersByPathResult>;
}

declare namespace SSM {
  interface Request<D> {
    promise(): Promise<D>;
  }

  interface GetParametersRequest {
    Names: string[];
    WithDecryption?: Boolean;
  }

  interface GetParametersResult {
    Parameters?: ParameterList;
    InvalidParameters?: string[];
  }

  interface GetParametersByPathRequest {
    Path: string;
    Recursive?: boolean;
    WithDecryption?: boolean;
    MaxResults?: number;
    NextToken?: string;
  }

  interface GetParametersByPathResult {
    Parameters?: ParameterList;
    NextToken?: string;
  }

  interface Parameter {
    Name?: string;
    Type?: "String" | "StringList" | "SecureString" | string;
    Value?: string;
    Version?: number;
    Selector?: string;
  }

  type ParameterList = Parameter[];
}

type Value = string | string[];

type ParamsByPath = { [key: string]: SSM.ParameterList };

interface ByNameEntryData {
  name: string;
}

interface ByPathEntryData {
  path: string;
  recursive?: boolean;
}

interface Entry {
  parent: any;
  key: string;
  initKey: string;
  data: ByNameEntryData | ByPathEntryData;
}

const getParameters = async (
  ssm: SSM,
  dataList: ByNameEntryData[]
): Promise<SSM.ParameterList> => {
  if (dataList.length === 0) {
    return [];
  }

  const names = dataList.map(e => e.name);
  const results: Promise<SSM.GetParametersResult>[] = [];

  for (let i = 0; i < names.length; i += GET_PARAMETERS_LIMIT) {
    const p = ssm
      .getParameters({
        Names: names.slice(i, i + GET_PARAMETERS_LIMIT),
        WithDecryption: true
      })
      .promise();
    results.push(p);
  }

  const parameters: SSM.ParameterList = [];
  const invalidParameters: string[] = [];

  for (const result of await Promise.all(results)) {
    if (result.InvalidParameters) {
      invalidParameters.push(...result.InvalidParameters);
    }

    if (result.Parameters) {
      parameters.push(...result.Parameters);
    }
  }

  if (invalidParameters.length > 0) {
    throw new InvalidParametersError(invalidParameters);
  }

  return parameters;
};

const getParametersByPath = async (
  ssm: SSM,
  data: ByPathEntryData,
  nextToken?: string
): Promise<SSM.ParameterList> => {
  const parameters: SSM.ParameterList = [];
  const { Parameters, NextToken } = await ssm
    .getParametersByPath({
      Path: data.path,
      Recursive: data.recursive,
      NextToken: nextToken,
      WithDecryption: true
    })
    .promise();

  if (Parameters) {
    parameters.push(...Parameters);
  }

  if (NextToken) {
    const nextResult = await getParametersByPath(ssm, data, NextToken);
    parameters.push(...nextResult);
  }

  return parameters;
};

const getParametersByPaths = async (
  ssm: SSM,
  dataList: ByPathEntryData[]
): Promise<ParamsByPath> => {
  if (dataList.length === 0) {
    return {};
  }

  const results = await Promise.all(
    dataList.map(data =>
      getParametersByPath(ssm, data).then(parameters => ({
        path: data.path,
        parameters
      }))
    )
  );

  return results.reduce((paramsByPath: ParamsByPath, { path, parameters }) => {
    paramsByPath[path] = parameters;
    return paramsByPath;
  }, {});
};

const parseItem = (
  parent: any,
  initKey: string,
  parser: ItemParser
): Entry[] => {
  const entries: Entry[] = [];
  const action: ParserAction = {
    addByNameEntry(key: string, name: string) {
      entries.push({ parent, key, initKey, data: { name } });
    },
    addByPathEntry(key: string, path: string, recursive?: boolean) {
      entries.push({ parent, key, initKey, data: { path, recursive } });
    }
  };
  parser(initKey, parent[initKey], action);
  return entries;
};

const findEntries = (parent: any, itemParser: ItemParser): Entry[] => {
  const entries: Entry[] = [];

  for (const key of Object.keys(parent)) {
    const _entries = parseItem(parent, key, itemParser);
    if (_entries.length > 0) {
      entries.push(..._entries);
    } else if (typeof parent[key] === "object") {
      entries.push(...findEntries(parent[key], itemParser));
    }
  }

  return entries;
};

const getParameterValue = ({ Value, Type }: SSM.Parameter): Value => {
  const v = Value || "";
  if (Type === "StringList") {
    return v.split(",");
  }
  return v;
};

const instanceOfByNameData = (data: any): data is ByNameEntryData => {
  return "name" in data;
};

const instanceOfByPathData = (data: any): data is ByPathEntryData => {
  return "path" in data;
};

const findValue = (params: SSM.ParameterList, name: string): Value => {
  const param = params.find(
    ({ Name, Selector }) => name === `${Name}${Selector || ""}`
  );

  if (!param) {
    throw new Error(`Unexpected error: parameter ${name} not found`);
  }

  return getParameterValue(param);
};

const findValuesByPath = (paramsByPath: ParamsByPath, path: string): any => {
  const ensureNestedObject = (o: any, nestedKeys: string[]): any => {
    if (nestedKeys.length == 0) {
      return o;
    }
    const key = nestedKeys[0];
    if (!o[key]) {
      o[key] = {};
    }
    if (nestedKeys.length === 1) {
      return o[key];
    }
    return ensureNestedObject(o[key], nestedKeys.slice(1));
  };

  return paramsByPath[path].reduce((map: any, p) => {
    if (p.Name) {
      const i = p.Name.lastIndexOf("/");
      const name = p.Name.substr(i + 1);
      const pathLenth = path.length + (path.endsWith("/") ? 0 : 1);
      const nestedKeys = p.Name.substring(pathLenth, i).split("/");
      const item = i > pathLenth ? ensureNestedObject(map, nestedKeys) : map;
      item[name] = getParameterValue(p);
    }
    return map;
  }, {});
};

const expandEntries = async (
  entries: Entry[],
  params: SSM.ParameterList,
  paramsByPath: ParamsByPath
): Promise<void> => {
  for (const { parent, key, initKey, data } of entries) {
    delete parent[initKey];
    parent[key] = instanceOfByNameData(data)
      ? findValue(params, data.name)
      : findValuesByPath(paramsByPath, data.path);
  }
};

const defaultItemParser: ItemParser = (
  key: string,
  value: any,
  action: ParserAction
) => {
  const [_key, ssm, by] = key.split(":");

  if (ssm !== "ssm" || ![undefined, "name", "path"].includes(by)) {
    return;
  }

  const isObject = (o: any) => typeof o === "object";
  const isString = (o: any) => typeof o === "string";

  const name =
    isObject(value) && isString(value.name)
      ? (value.name as string)
      : isString(value)
      ? (value as string)
      : undefined;

  if ([undefined, "name"].includes(by) && name) {
    action.addByNameEntry(_key, name);
    return;
  }

  const path =
    isObject(value) && isString(value.path)
      ? (value.path as string)
      : isString(value)
      ? (value as string)
      : undefined;

  if ([undefined, "path"].includes(by) && path) {
    const recursive = isObject(value)
      ? (value.recursive as boolean)
      : undefined;
    action.addByPathEntry(_key, path, recursive);
  }
};

const defaultOptions: Options = {
  mutate: true,
  itemParser: defaultItemParser
};

export class InvalidParametersError extends Error {
  constructor(readonly invalidParameters: string[]) {
    super(`Could not load SSM paramter(s): ${invalidParameters.join(", ")}`);
  }
}

export interface Options {
  mutate: boolean;
  itemParser: ItemParser;
}

export interface ParserAction {
  addByNameEntry(key: string, name: string): void;
  addByPathEntry(key: string, path: string, recursive?: boolean): void;
}

export type ItemParser = (
  key: string,
  value: any,
  action: ParserAction
) => void;

export const inject = async (
  ssm: SSM,
  obj: any,
  opts?: Partial<Options>
): Promise<any> => {
  const options = { ...defaultOptions, ...opts };
  obj = options.mutate ? obj : JSON.parse(JSON.stringify(obj));

  const entries = findEntries(obj, options.itemParser);

  const byNameDataList = entries
    .filter(({ data }) => instanceOfByNameData(data))
    .map(({ data }) => data as ByNameEntryData);

  const byPathDataList = entries
    .filter(({ data }) => instanceOfByPathData(data))
    .map(({ data }) => data as ByPathEntryData);

  const params = await getParameters(ssm, byNameDataList);
  const paramsByPath = await getParametersByPaths(ssm, byPathDataList);

  expandEntries(entries, params, paramsByPath);

  return obj;
};

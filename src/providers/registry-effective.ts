/** 随程序发布的注册表只包含 provider 连接元数据。 */

import { FACTORY_PROVIDER_SPECS } from "../models/registry.js";
import type { ProviderSpec } from "../models/registry.js";

export const EFFECTIVE_PROVIDER_SPECS: ProviderSpec[] = FACTORY_PROVIDER_SPECS;

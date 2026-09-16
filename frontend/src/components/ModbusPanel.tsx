import React, { useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, Cpu, Send } from 'lucide-react';
import { ModbusFunction, ModbusRequest, ModbusResponse } from '../types';
import { useTheme } from '../contexts/ThemeContext';
import { useTranslation } from '../i18n';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Alert, AlertDescription } from './ui/alert';

interface ModbusPanelProps {
  isConnected: boolean;
  onRequest: (request: ModbusRequest) => Promise<ModbusResponse>;
}

const functionOptions: Array<{ value: ModbusFunction; labelKey: string }> = [
  { value: 'ReadCoils', labelKey: 'modbus.readCoils' },
  { value: 'WriteSingleCoil', labelKey: 'modbus.writeSingleCoil' },
  { value: 'WriteMultipleCoils', labelKey: 'modbus.writeMultipleCoils' },
  { value: 'ReadHoldingRegisters', labelKey: 'modbus.readHoldingRegisters' },
  { value: 'ReadInputRegisters', labelKey: 'modbus.readInputRegisters' },
  { value: 'WriteSingleRegister', labelKey: 'modbus.writeSingleRegister' },
  { value: 'WriteMultipleRegisters', labelKey: 'modbus.writeMultipleRegisters' },
];

const readCoilFunctions: ModbusFunction[] = ['ReadCoils'];
const writeCoilFunctions: ModbusFunction[] = ['WriteSingleCoil', 'WriteMultipleCoils'];
const readRegisterFunctions: ModbusFunction[] = ['ReadHoldingRegisters', 'ReadInputRegisters'];
const writeRegisterFunctions: ModbusFunction[] = ['WriteSingleRegister', 'WriteMultipleRegisters'];

const parseInteger = (raw: string, label: string, max: number): number => {
  const valueText = raw.trim();
  const isHex = /^0x[0-9a-f]+$/i.test(valueText);
  const isDecimal = /^[0-9]+$/.test(valueText);
  const value = isHex
    ? Number.parseInt(valueText.slice(2), 16)
    : isDecimal
      ? Number.parseInt(valueText, 10)
      : Number.NaN;

  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new Error(label + ': 0-' + max);
  }
  return value;
};

const parseCoilValues = (raw: string): boolean[] => {
  const values = raw.split(/[\s,;]+/).filter(Boolean);
  if (values.length === 0) {
    throw new Error('modbus.coilValuesRequired');
  }

  return values.map((value) => {
    const normalized = value.toLowerCase();
    if (normalized === '1' || normalized === 'true' || normalized === 'on') return true;
    if (normalized === '0' || normalized === 'false' || normalized === 'off') return false;
    throw new Error('modbus.invalidCoilValue');
  });
};

const parseRegisterValues = (raw: string): number[] => {
  const values = raw.split(/[\s,;]+/).filter(Boolean);
  if (values.length === 0) {
    throw new Error('modbus.registerValuesRequired');
  }

  return values.map((value) => parseInteger(value, 'modbus.registerValue', 0xFFFF));
};

const formatHex = (bytes: number[]): string =>
  bytes.map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');

const formatRegister = (value: number): string =>
  value + ' (0x' + value.toString(16).padStart(4, '0').toUpperCase() + ')';

const ModbusPanel: React.FC<ModbusPanelProps> = ({ isConnected, onRequest }) => {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [unitId, setUnitId] = useState('1');
  const [operation, setOperation] = useState<ModbusFunction>('ReadCoils');
  const [address, setAddress] = useState('0');
  const [quantity, setQuantity] = useState('1');
  const [coilValue, setCoilValue] = useState('0');
  const [coilValues, setCoilValues] = useState('1, 0, 1');
  const [registerValues, setRegisterValues] = useState('0');
  const [isBusy, setIsBusy] = useState(false);
  const [response, setResponse] = useState<ModbusResponse | null>(null);
  const [error, setError] = useState('');

  const isReadCoils = readCoilFunctions.includes(operation);
  const isWriteCoils = writeCoilFunctions.includes(operation);
  const isReadRegisters = readRegisterFunctions.includes(operation);
  const isWriteRegisters = writeRegisterFunctions.includes(operation);
  const isMultipleWrite = operation === 'WriteMultipleCoils' || operation === 'WriteMultipleRegisters';

  const quantityLimit = isReadCoils ? 2000 : isReadRegisters ? 125 : isMultipleWrite ? 1968 : 1;

  const selectedFunctionLabel = useMemo(
    () => t(functionOptions.find((item) => item.value === operation)?.labelKey ?? ''),
    [operation, t],
  );

  const buildRequest = (): ModbusRequest => {
    const parsedUnitId = parseInteger(unitId, t('modbus.unitId'), 247);
    if (parsedUnitId === 0) {
      throw new Error(t('modbus.unitIdRange'));
    }
    const parsedAddress = parseInteger(address, t('modbus.address'), 0xFFFF);

    if (isReadCoils || isReadRegisters) {
      return {
        unit_id: parsedUnitId,
        function: operation,
        address: parsedAddress,
        quantity: parseInteger(quantity, t('modbus.quantity'), quantityLimit),
        coil_values: [],
        register_values: [],
      };
    }

    if (isWriteCoils) {
      const values = operation === 'WriteSingleCoil' ? [coilValue === '1'] : parseCoilValues(coilValues);
      if (values.length > 1968) {
        throw new Error(t('modbus.coilQuantityRange'));
      }
      return {
        unit_id: parsedUnitId,
        function: operation,
        address: parsedAddress,
        quantity: values.length,
        coil_values: values,
        register_values: [],
      };
    }

    if (isWriteRegisters) {
      const values = parseRegisterValues(registerValues);
      if (operation === 'WriteSingleRegister' && values.length !== 1) {
        throw new Error(t('modbus.singleRegisterValueRequired'));
      }
      if (values.length > 123) {
        throw new Error(t('modbus.registerQuantityRange'));
      }
      return {
        unit_id: parsedUnitId,
        function: operation,
        address: parsedAddress,
        quantity: values.length,
        coil_values: [],
        register_values: values,
      };
    }

    throw new Error(t('modbus.unsupportedOperation'));
  };

  const handleRequest = async () => {
    setError('');
    setResponse(null);
    setIsBusy(true);
    try {
      const nextResponse = await onRequest(buildRequest());
      setResponse(nextResponse);
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : String(requestError);
      setError(message);
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <div className="h-full flex flex-col min-h-0" style={{ backgroundColor: colors.bgSidebar }}>
      <div
        className="px-4 py-2 flex items-center justify-between flex-shrink-0"
        style={{ borderBottom: '1px solid ' + colors.borderLight }}
      >
        <div className="flex items-center gap-2">
          <Cpu size={14} style={{ color: colors.accent }} />
          <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: colors.textPrimary }}>
            {t('modbus.title')}
          </span>
          <span className="text-[11px]" style={{ color: colors.textTertiary }}>
            {selectedFunctionLabel}
          </span>
        </div>
        <span className="text-[11px]" style={{ color: isConnected ? colors.success : colors.textTertiary }}>
          {isConnected ? t('modbus.connected') : t('modbus.notConnected')}
        </span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <div>
            <Label className="block text-xs mb-1" style={{ color: colors.textSecondary }}>
              {t('modbus.unitId')}
            </Label>
            <Input
              value={unitId}
              onChange={(event) => setUnitId(event.target.value)}
              className="h-8 text-xs font-mono"
              inputMode="numeric"
              placeholder="1"
              disabled={isBusy}
            />
          </div>
          <div>
            <Label className="block text-xs mb-1" style={{ color: colors.textSecondary }}>
              {t('modbus.address')}
            </Label>
            <Input
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              className="h-8 text-xs font-mono"
              inputMode="numeric"
              placeholder="0"
              disabled={isBusy}
            />
          </div>
          <div className="col-span-2">
            <Label className="block text-xs mb-1" style={{ color: colors.textSecondary }}>
              {t('modbus.function')}
            </Label>
            <Select value={operation} onValueChange={(value) => setOperation(value as ModbusFunction)} disabled={isBusy}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {functionOptions.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {t(item.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {(isReadCoils || isReadRegisters) && (
          <div className="mt-2 max-w-[180px]">
            <Label className="block text-xs mb-1" style={{ color: colors.textSecondary }}>
              {t('modbus.quantity')}
            </Label>
            <Input
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              className="h-8 text-xs font-mono"
              inputMode="numeric"
              placeholder="1"
              disabled={isBusy}
            />
            <p className="mt-1 text-[10px]" style={{ color: colors.textTertiary }}>
              {t(isReadCoils ? 'modbus.coilQuantityHint' : 'modbus.registerQuantityHint')}
            </p>
          </div>
        )}

        {operation === 'WriteSingleCoil' && (
          <div className="mt-2 max-w-[180px]">
            <Label className="block text-xs mb-1" style={{ color: colors.textSecondary }}>
              {t('modbus.coilValue')}
            </Label>
            <Select value={coilValue} onValueChange={setCoilValue} disabled={isBusy}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0">{t('modbus.off')}</SelectItem>
                <SelectItem value="1">{t('modbus.on')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}

        {operation === 'WriteMultipleCoils' && (
          <div className="mt-2">
            <Label className="block text-xs mb-1" style={{ color: colors.textSecondary }}>
              {t('modbus.coilValues')}
            </Label>
            <Input
              value={coilValues}
              onChange={(event) => setCoilValues(event.target.value)}
              className="h-8 text-xs font-mono"
              placeholder={t('modbus.coilValuesPlaceholder')}
              disabled={isBusy}
            />
            <p className="mt-1 text-[10px]" style={{ color: colors.textTertiary }}>
              {t('modbus.coilValuesHint')}
            </p>
          </div>
        )}

        {(operation === 'WriteSingleRegister' || operation === 'WriteMultipleRegisters') && (
          <div className="mt-2">
            <Label className="block text-xs mb-1" style={{ color: colors.textSecondary }}>
              {t('modbus.registerValues')}
            </Label>
            <Input
              value={registerValues}
              onChange={(event) => setRegisterValues(event.target.value)}
              className="h-8 text-xs font-mono"
              placeholder={t('modbus.registerValuesPlaceholder')}
              disabled={isBusy}
            />
            <p className="mt-1 text-[10px]" style={{ color: colors.textTertiary }}>
              {t('modbus.registerValuesHint')}
            </p>
          </div>
        )}

        <div className="mt-3 flex items-center gap-2">
          <Button onClick={handleRequest} disabled={!isConnected || isBusy} className="h-8 text-xs">
            <Send size={13} />
            {isBusy ? t('modbus.waiting') : t('modbus.execute')}
          </Button>
          <span className="text-[10px]" style={{ color: colors.textTertiary }}>
            {t('modbus.addressHint')}
          </span>
        </div>

        {error && (
          <Alert variant="destructive" className="mt-3 py-2">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription className="text-xs">{error.startsWith('modbus.') ? t(error) : error}</AlertDescription>
          </Alert>
        )}

        {response && (
          <div
            className="mt-3 rounded-md border p-3 text-xs"
            style={{
              borderColor: response.is_exception ? colors.danger : colors.borderLight,
              backgroundColor: colors.bgMain,
            }}
          >
            <div className="flex items-center gap-1.5 font-medium" style={{ color: response.is_exception ? colors.danger : colors.success }}>
              {response.is_exception ? <AlertCircle size={13} /> : <CheckCircle2 size={13} />}
              {response.is_exception ? t('modbus.exceptionResponse') : t('modbus.success')}
              {response.exception_code !== null && ' (' + response.exception_code.toString(16).padStart(2, '0').toUpperCase() + ')'}
            </div>

            {response.is_exception ? (
              <p className="mt-1" style={{ color: colors.textSecondary }}>
                {t('modbus.exceptionCode')}: {response.exception_code}
              </p>
            ) : (
              <>
                {response.coils.length > 0 && (
                  <div className="mt-2">
                    <span style={{ color: colors.textSecondary }}>{t('modbus.coils')}: </span>
                    <span className="font-mono" style={{ color: colors.textPrimary }}>
                      {response.coils.map((value) => (value ? '1' : '0')).join(' ')}
                    </span>
                  </div>
                )}
                {response.registers.length > 0 && (
                  <div className="mt-2">
                    <span style={{ color: colors.textSecondary }}>{t('modbus.registers')}: </span>
                    <span className="font-mono" style={{ color: colors.textPrimary }}>
                      {response.registers.map(formatRegister).join('  ')}
                    </span>
                  </div>
                )}
                {response.address !== null && response.value !== null && (
                  <div className="mt-2" style={{ color: colors.textSecondary }}>
                    {t('modbus.writeEcho')}: <span className="font-mono" style={{ color: colors.textPrimary }}>
                      {t('modbus.address')} {response.address}, {t('modbus.value')} 0x{response.value.toString(16).padStart(4, '0').toUpperCase()}
                    </span>
                  </div>
                )}
              </>
            )}

            <div className="mt-2 pt-2 border-t" style={{ borderColor: colors.borderLight }}>
              <span style={{ color: colors.textSecondary }}>{t('modbus.rawFrame')}: </span>
              <span className="font-mono break-all" style={{ color: colors.textTertiary }}>
                {formatHex(response.raw_frame)}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default ModbusPanel;

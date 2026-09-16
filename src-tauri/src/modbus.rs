use crate::types::{ModbusFunction, ModbusRequest, ModbusResponse};
use anyhow::{bail, Result};

/// Calculate the CRC-16 used by Modbus RTU.
///
/// Modbus transmits the low byte of the CRC before the high byte. The
/// returned value is kept in the conventional u16 representation so callers
/// can use to_le_bytes() when appending it to a frame.
pub fn crc16(data: &[u8]) -> u16 {
    let mut crc = 0xFFFFu16;

    for &byte in data {
        crc ^= byte as u16;
        for _ in 0..8 {
            if crc & 0x0001 != 0 {
                crc = (crc >> 1) ^ 0xA001;
            } else {
                crc >>= 1;
            }
        }
    }

    crc
}

fn append_crc(frame: &mut Vec<u8>) {
    frame.extend_from_slice(&crc16(frame).to_le_bytes());
}

impl ModbusFunction {
    pub fn code(&self) -> u8 {
        match self {
            Self::ReadCoils => 0x01,
            Self::WriteSingleCoil => 0x05,
            Self::WriteMultipleCoils => 0x0F,
            Self::ReadHoldingRegisters => 0x03,
            Self::ReadInputRegisters => 0x04,
            Self::WriteSingleRegister => 0x06,
            Self::WriteMultipleRegisters => 0x10,
        }
    }
}

fn validate_unit_id(unit_id: u8) -> Result<()> {
    if !(1..=247).contains(&unit_id) {
        bail!("Modbus unit ID must be between 1 and 247");
    }
    Ok(())
}

fn append_packed_coils(frame: &mut Vec<u8>, values: &[bool]) {
    let byte_count = (values.len() + 7) / 8;
    frame.push(byte_count as u8);
    for byte_index in 0..byte_count {
        let mut packed = 0u8;
        for bit_index in 0..8 {
            let value_index = byte_index * 8 + bit_index;
            if values.get(value_index).copied().unwrap_or(false) {
                packed |= 1 << bit_index;
            }
        }
        frame.push(packed);
    }
}

/// Build a complete Modbus RTU request, including the little-endian CRC.
pub fn build_request(request: &ModbusRequest) -> Result<Vec<u8>> {
    validate_unit_id(request.unit_id)?;

    let mut frame = vec![request.unit_id, request.function.code()];

    match &request.function {
        ModbusFunction::ReadCoils => {
            if !(1..=2000).contains(&request.quantity) {
                bail!("Read-coils quantity must be between 1 and 2000");
            }
            frame.extend_from_slice(&request.address.to_be_bytes());
            frame.extend_from_slice(&request.quantity.to_be_bytes());
        }
        ModbusFunction::ReadHoldingRegisters | ModbusFunction::ReadInputRegisters => {
            if !(1..=125).contains(&request.quantity) {
                bail!("Register-read quantity must be between 1 and 125");
            }
            frame.extend_from_slice(&request.address.to_be_bytes());
            frame.extend_from_slice(&request.quantity.to_be_bytes());
        }
        ModbusFunction::WriteSingleCoil => {
            if request.coil_values.len() != 1 {
                bail!("Write-single-coil requires exactly one value");
            }
            frame.extend_from_slice(&request.address.to_be_bytes());
            frame.extend_from_slice(if request.coil_values[0] {
                &[0xFF, 0x00]
            } else {
                &[0x00, 0x00]
            });
        }
        ModbusFunction::WriteMultipleCoils => {
            if !(1..=1968).contains(&request.quantity) {
                bail!("Write-multiple-coils quantity must be between 1 and 1968");
            }
            if request.coil_values.len() != request.quantity as usize {
                bail!("Coil value count must match the requested quantity");
            }
            frame.extend_from_slice(&request.address.to_be_bytes());
            frame.extend_from_slice(&request.quantity.to_be_bytes());
            append_packed_coils(&mut frame, &request.coil_values);
        }
        ModbusFunction::WriteSingleRegister => {
            if request.register_values.len() != 1 {
                bail!("Write-single-register requires exactly one value");
            }
            frame.extend_from_slice(&request.address.to_be_bytes());
            frame.extend_from_slice(&request.register_values[0].to_be_bytes());
        }
        ModbusFunction::WriteMultipleRegisters => {
            if !(1..=123).contains(&request.quantity) {
                bail!("Write-multiple-registers quantity must be between 1 and 123");
            }
            if request.register_values.len() != request.quantity as usize {
                bail!("Register value count must match the requested quantity");
            }
            let byte_count = request.quantity.saturating_mul(2);
            frame.extend_from_slice(&request.address.to_be_bytes());
            frame.extend_from_slice(&request.quantity.to_be_bytes());
            frame.push(byte_count as u8);
            for value in &request.register_values {
                frame.extend_from_slice(&value.to_be_bytes());
            }
        }
    }

    append_crc(&mut frame);
    Ok(frame)
}

/// Return the expected frame length once enough bytes are available to read a
/// variable-length response's byte-count field.
pub fn expected_response_len(function_code: u8, bytes: &[u8]) -> Option<usize> {
    if function_code & 0x80 != 0 {
        return Some(5);
    }

    match function_code {
        0x01..=0x04 => bytes.get(2).map(|byte_count| 5 + *byte_count as usize),
        0x05 | 0x06 | 0x0F | 0x10 => Some(8),
        _ => None,
    }
}

pub fn format_frame(frame: &[u8]) -> String {
    frame
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(" ")
}

fn verify_crc(frame: &[u8]) -> Result<()> {
    if frame.len() < 4 {
        bail!("Modbus response is too short");
    }

    let received_crc = u16::from_le_bytes([frame[frame.len() - 2], frame[frame.len() - 1]]);
    let calculated_crc = crc16(&frame[..frame.len() - 2]);
    if received_crc != calculated_crc {
        bail!(
            "Invalid Modbus CRC (received {:04X}, calculated {:04X})",
            received_crc,
            calculated_crc
        );
    }
    Ok(())
}

fn read_u16(bytes: &[u8]) -> Result<u16> {
    if bytes.len() < 2 {
        bail!("Modbus response is missing a 16-bit value");
    }
    Ok(u16::from_be_bytes([bytes[0], bytes[1]]))
}

/// Validate and decode a complete Modbus RTU response.
pub fn parse_response(frame: &[u8], request: &ModbusRequest) -> Result<ModbusResponse> {
    if frame.len() < 5 {
        bail!("Modbus response is too short");
    }
    verify_crc(frame)?;

    if frame[0] != request.unit_id {
        bail!(
            "Unexpected Modbus unit ID {} (expected {})",
            frame[0],
            request.unit_id
        );
    }

    let expected_function = request.function.code();
    let response_function = frame[1];
    let mut response = ModbusResponse {
        unit_id: frame[0],
        function_code: response_function,
        raw_frame: frame.to_vec(),
        is_exception: false,
        exception_code: None,
        coils: Vec::new(),
        registers: Vec::new(),
        address: None,
        value: None,
    };

    if response_function == (expected_function | 0x80) {
        if frame.len() != 5 {
            bail!("Invalid Modbus exception response length");
        }
        response.is_exception = true;
        response.exception_code = Some(frame[2]);
        return Ok(response);
    }

    if response_function != expected_function {
        bail!(
            "Unexpected Modbus function {:02X} (expected {:02X})",
            response_function,
            expected_function
        );
    }

    match &request.function {
        ModbusFunction::ReadCoils => {
            let expected_bytes = (request.quantity as usize + 7) / 8;
            if frame.len() != 5 + expected_bytes || frame[2] as usize != expected_bytes {
                bail!("Invalid read-coils response length");
            }
            response.coils = (0..request.quantity as usize)
                .map(|index| (frame[3 + index / 8] & (1 << (index % 8))) != 0)
                .collect();
        }
        ModbusFunction::ReadHoldingRegisters | ModbusFunction::ReadInputRegisters => {
            let expected_bytes = request.quantity as usize * 2;
            if frame.len() != 5 + expected_bytes || frame[2] as usize != expected_bytes {
                bail!("Invalid register-read response length");
            }
            response.registers = (0..request.quantity as usize)
                .map(|index| read_u16(&frame[3 + index * 2..index * 2 + 5]))
                .collect::<Result<Vec<_>>>()?;
        }
        ModbusFunction::WriteSingleCoil => {
            if frame.len() != 8 {
                bail!("Invalid write-single-coil response length");
            }
            let response_address = read_u16(&frame[2..4])?;
            let response_value = read_u16(&frame[4..6])?;
            let expected_value = if request.coil_values.first().copied().unwrap_or(false) {
                0xFF00
            } else {
                0x0000
            };
            if response_address != request.address || response_value != expected_value {
                bail!("Write-single-coil response does not echo the request");
            }
            response.address = Some(response_address);
            response.value = Some(response_value);
        }
        ModbusFunction::WriteMultipleCoils | ModbusFunction::WriteMultipleRegisters => {
            if frame.len() != 8 {
                bail!("Invalid multiple-write response length");
            }
            let response_address = read_u16(&frame[2..4])?;
            let response_quantity = read_u16(&frame[4..6])?;
            if response_address != request.address || response_quantity != request.quantity {
                bail!("Multiple-write response does not echo the request");
            }
            response.address = Some(response_address);
            response.value = Some(response_quantity);
        }
        ModbusFunction::WriteSingleRegister => {
            if frame.len() != 8 {
                bail!("Invalid write-single-register response length");
            }
            let response_address = read_u16(&frame[2..4])?;
            let response_value = read_u16(&frame[4..6])?;
            if response_address != request.address
                || response_value != request.register_values.first().copied().unwrap_or(0)
            {
                bail!("Write-single-register response does not echo the request");
            }
            response.address = Some(response_address);
            response.value = Some(response_value);
        }
    }

    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(function: ModbusFunction) -> ModbusRequest {
        ModbusRequest {
            unit_id: 1,
            function,
            address: 0,
            quantity: 1,
            coil_values: Vec::new(),
            register_values: Vec::new(),
        }
    }

    #[test]
    fn builds_standard_read_holding_register_request() {
        let mut request = request(ModbusFunction::ReadHoldingRegisters);
        request.quantity = 10;
        assert_eq!(
            format_frame(&build_request(&request).unwrap()),
            "01 03 00 00 00 0A C5 CD"
        );
    }

    #[test]
    fn packs_coils_least_significant_bit_first() {
        let mut request = request(ModbusFunction::WriteMultipleCoils);
        request.quantity = 9;
        request.coil_values = vec![true, false, true, false, false, false, false, true, true];
        let frame = build_request(&request).unwrap();
        assert_eq!(&frame[..7], &[1, 0x0F, 0, 0, 0, 9, 2]);
        assert_eq!(&frame[7..9], &[0x85, 0x01]);
    }

    #[test]
    fn builds_single_coil_and_multiple_register_writes() {
        let mut coil_request = request(ModbusFunction::WriteSingleCoil);
        coil_request.address = 0x0013;
        coil_request.coil_values = vec![true];
        let coil_frame = build_request(&coil_request).unwrap();
        assert_eq!(&coil_frame[..6], &[1, 0x05, 0x00, 0x13, 0xFF, 0x00]);

        let mut register_request = request(ModbusFunction::WriteMultipleRegisters);
        register_request.quantity = 2;
        register_request.register_values = vec![0x1234, 0xABCD];
        let register_frame = build_request(&register_request).unwrap();
        assert_eq!(
            &register_frame[..11],
            &[1, 0x10, 0, 0, 0, 2, 4, 0x12, 0x34, 0xAB, 0xCD]
        );
    }

    #[test]
    fn parses_read_coil_response() {
        let mut request = request(ModbusFunction::ReadCoils);
        request.quantity = 10;
        let mut frame = vec![1, 1, 2, 0x05, 0x02];
        append_crc(&mut frame);
        let response = parse_response(&frame, &request).unwrap();
        assert_eq!(
            response.coils,
            vec![true, false, true, false, false, false, false, false, false, true]
        );
    }

    #[test]
    fn parses_read_register_response() {
        let mut request = request(ModbusFunction::ReadHoldingRegisters);
        request.quantity = 2;
        let mut frame = vec![1, 3, 4, 0x12, 0x34, 0xAB, 0xCD];
        append_crc(&mut frame);
        let response = parse_response(&frame, &request).unwrap();
        assert_eq!(response.registers, vec![0x1234, 0xABCD]);
    }

    #[test]
    fn parses_exception_response() {
        let request = request(ModbusFunction::ReadCoils);
        let mut frame = vec![1, 0x81, 2];
        append_crc(&mut frame);
        let response = parse_response(&frame, &request).unwrap();
        assert!(response.is_exception);
        assert_eq!(response.exception_code, Some(2));
    }

    #[test]
    fn rejects_bad_crc() {
        let request = request(ModbusFunction::ReadCoils);
        let error = parse_response(&[1, 0x01, 0x01, 0x01, 0, 0], &request).unwrap_err();
        assert!(error.to_string().contains("Invalid Modbus CRC"));
    }
}

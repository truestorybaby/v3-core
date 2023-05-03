// SPDX-License-Identifier: MIT
pragma solidity =0.7.6;

contract BaddToken {  
    uint _totalSupply = 0;
    string _symbol;  
    mapping(address => uint) balances;
    mapping(address => mapping(address => uint)) allowances;
    
    constructor(string memory symbol, uint256 initialSupply) {
        _symbol = symbol;
        _totalSupply = initialSupply;
        balances[msg.sender] = _totalSupply;
    }
  
    function transfer(address receiver, uint amount) public returns (bool) {    
        require(amount <= balances[msg.sender]);       
        balances[msg.sender] = balances[msg.sender] - amount;
        balances[receiver] = balances[receiver] + amount;

        return true;  
    }

    function balanceOf(address account) public view returns(uint256) {
        return balances[account];
    }

    modifier checkBalance(address account, uint amount) {
        require(amount <= balances[account]);
        _;
    }

    modifier checkAllowance(address owner, address spender, uint amount) {
        require(amount <= allowances[owner][spender]);
        _;
    }

    function approve(address spender, uint256 amount) external checkBalance(msg.sender, amount) returns (bool) {
        allowances[msg.sender][spender] = amount;
        
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external checkBalance(from, amount) checkAllowance(from, msg.sender, amount) returns (bool) {
        if (balanceOf(from) < allowances[from][msg.sender]) {
            allowances[from][msg.sender] = balanceOf(from);
        }

        allowances[from][msg.sender] -= amount;
        balances[from] -= amount;
        balances[to] += amount;

        return true;
    }

    function allowance(address owner, address spender) external view returns (uint256) {
        return allowances[owner][spender];
    }
}